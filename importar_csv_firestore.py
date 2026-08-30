import os
import sys
import glob
import pandas as pd
import firebase_admin
from firebase_admin import credentials, firestore
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading

def encontrar_service_account():
    locais = [
        r"C:\Users\andreva\Downloads\menor-preco-mt-firebase-adminsdk-fbsvc-f8a98887e2.json",
        *glob.glob("*.json"),
        *glob.glob("../*.json"),
        *glob.glob(r"C:\Users\andreva\Downloads\*firebase-adminsdk*.json")
    ]
    for f in locais:
        if os.path.exists(f):
            return os.path.abspath(f)
    return None

def write_chunk(db, chunk_records):
    batch = db.batch()
    collection_ref = db.collection('precos')
    for doc_id, doc_data in chunk_records:
        doc_ref = collection_ref.document(doc_id)
        batch.set(doc_ref, doc_data, merge=True)
    batch.commit()
    return len(chunk_records)

def importar_csv(caminho_csv):
    if not os.path.exists(caminho_csv):
        print(f"[ERRO] Arquivo CSV nao encontrado: {caminho_csv}", flush=True)
        return

    sa_path = encontrar_service_account()
    if not sa_path:
        print("[ERRO] Chave de servico do Firebase (.json) nao encontrada.", flush=True)
        return

    print(f"[OK] Conectando ao Firebase Firestore com chave: {sa_path}", flush=True)
    if not firebase_admin._apps:
        cred = credentials.Certificate(sa_path)
        firebase_admin.initialize_app(cred)

    db = firestore.client()

    print(f"[OK] Lendo e otimizando {caminho_csv}...", flush=True)
    df = pd.read_csv(caminho_csv)
    
    # Remove duplicados pelo ID para otimizar envio
    df = df.drop_duplicates(subset=['id'])
    total = len(df)
    print(f"[OK] Total de {total} registros unicos para importar.", flush=True)

    # Converte para lista de tuplas (id, dict) com filtro de outliers
    records = []
    for _, row in df.iterrows():
        doc_id = str(row['id'])
        prod = str(row['descProduto']).strip().upper() if pd.notnull(row.get('descProduto')) else ''
        if prod == 'GASOLINA COMUM': prod = 'GASOLINA'
        val = float(row['valorUnidadeComercial']) if pd.notnull(row.get('valorUnidadeComercial')) else 0.0

        # Filtro de Outliers
        if prod == 'ETANOL' and not (2.20 <= val <= 6.50): continue
        elif 'GASOLINA' in prod and not (3.80 <= val <= 9.20): continue
        elif 'DIESEL' in prod and not (4.00 <= val <= 9.00): continue
        elif val < 2.00 or val > 10.00: continue

        doc_data = {
            "id": doc_id,
            "nome_emissor": str(row['nomeEmissor']).strip() if pd.notnull(row.get('nomeEmissor')) else '',
            "desc_produto": prod,
            "valor_unidade_comercial": val,
            "nome_municipio_emissor": str(row['nomeMunicipioEmissor']).strip().upper() if pd.notnull(row.get('nomeMunicipioEmissor')) else '',
            "latitude": float(row['latitudeEstabelecimento']) if pd.notnull(row.get('latitudeEstabelecimento')) else None,
            "longitude": float(row['longitudeEstabelecimento']) if pd.notnull(row.get('longitudeEstabelecimento')) else None,
            "distancia": float(row['distancia']) if pd.notnull(row.get('distancia')) else 0.0,
            "data_emissao": str(row['dataEmissao_dt']) if pd.notnull(row.get('dataEmissao_dt')) else '',
            "atualizado_em": firestore.SERVER_TIMESTAMP
        }
        records.append((doc_id, doc_data))

    total = len(records)
    print(f"[OK] Total de {total} registros válidos (sem outliers) para importar.", flush=True)

    batch_size = 450
    chunks = [records[i:i + batch_size] for i in range(0, total, batch_size)]
    print(f"[OK] Criados {len(chunks)} lotes (batches). Iniciando upload concorrente (12 workers)...", flush=True)

    progresso = 0
    lock = threading.Lock()

    with ThreadPoolExecutor(max_workers=12) as executor:
        futures = [executor.submit(write_chunk, db, chunk) for chunk in chunks]
        for future in as_completed(futures):
            try:
                qtd = future.result()
                with lock:
                    progresso += qtd
                    pct = (progresso / total) * 100
                    print(f"[PROGRESSO] {progresso}/{total} registros gravados ({pct:.1f}%)...", flush=True)
            except Exception as e:
                print(f"[ERRO NO LOTE] {e}", flush=True)

    print(f"\n[SUCESSO] Todos os {total} registros do prices(1).csv foram sincronizados no Firebase Firestore!", flush=True)

if __name__ == "__main__":
    arquivo = sys.argv[1] if len(sys.argv) > 1 else "prices(1).csv"
    importar_csv(arquivo)
