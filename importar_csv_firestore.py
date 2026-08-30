import os
import sys
import glob
import pandas as pd
import firebase_admin
from firebase_admin import credentials, firestore

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

def importar_csv(caminho_csv):
    if not os.path.exists(caminho_csv):
        print(f"[ERRO] Arquivo CSV nao encontrado: {caminho_csv}")
        return

    sa_path = encontrar_service_account()
    if not sa_path:
        print("[ERRO] Chave de servico do Firebase (.json) nao encontrada.")
        return

    print(f"[OK] Usando chave: {sa_path}")
    if not firebase_admin._apps:
        cred = credentials.Certificate(sa_path)
        firebase_admin.initialize_app(cred)

    db = firestore.client()
    collection_ref = db.collection('precos')

    print(f"[OK] Lendo {caminho_csv}...")
    df = pd.read_csv(caminho_csv)
    total = len(df)
    print(f"[OK] Total de {total} registros para importar.")

    batch_size = 400
    gravados = 0

    for i in range(0, total, batch_size):
        batch = db.batch()
        chunk = df.iloc[i:i + batch_size]

        for _, row in chunk.iterrows():
            doc_id = str(row['id'])
            doc_ref = collection_ref.document(doc_id)

            doc_data = {
                "id": doc_id,
                "nome_emissor": str(row['nomeEmissor']).strip() if pd.notnull(row.get('nomeEmissor')) else '',
                "desc_produto": str(row['descProduto']).strip().upper() if pd.notnull(row.get('descProduto')) else '',
                "valor_unidade_comercial": float(row['valorUnidadeComercial']) if pd.notnull(row.get('valorUnidadeComercial')) else 0.0,
                "nome_municipio_emissor": str(row['nomeMunicipioEmissor']).strip().upper() if pd.notnull(row.get('nomeMunicipioEmissor')) else '',
                "latitude": float(row['latitudeEstabelecimento']) if pd.notnull(row.get('latitudeEstabelecimento')) else None,
                "longitude": float(row['longitudeEstabelecimento']) if pd.notnull(row.get('longitudeEstabelecimento')) else None,
                "distancia": float(row['distancia']) if pd.notnull(row.get('distancia')) else 0.0,
                "data_emissao": str(row['dataEmissao_dt']) if pd.notnull(row.get('dataEmissao_dt')) else '',
                "atualizado_em": firestore.SERVER_TIMESTAMP
            }
            batch.set(doc_ref, doc_data, merge=True)

        batch.commit()
        gravados += len(chunk)
        print(f"[PROGRESSO] {gravados}/{total} registros gravados no Firestore...")

    print(f"\n[SUCESSO] Todos os {total} registros foram importados para o Firebase Firestore!")

if __name__ == "__main__":
    arquivo = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\andreva\Downloads\prices.csv"
    importar_csv(arquivo)
