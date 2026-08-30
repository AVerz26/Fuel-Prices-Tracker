import time
import json
import requests
import os
import sys
import argparse
from datetime import datetime
import pandas as pd
from io import StringIO
from playwright.sync_api import sync_playwright
from dotenv import load_dotenv

import firebase_admin
from firebase_admin import credentials, firestore

# Carrega variáveis de ambiente de um arquivo .env se existir
load_dotenv()

# Configurações de Credenciais SEFAZ
SEFAZ_USERNAME = os.getenv('SEFAZ_USERNAME', '45812131856')
SEFAZ_PASSWORD = os.getenv('SEFAZ_PASSWORD', 'g80y5vxb8w')

# Credencial do Firebase (Pode ser o caminho do arquivo JSON ou a string JSON direto)
FIREBASE_SERVICE_ACCOUNT = os.getenv('FIREBASE_SERVICE_ACCOUNT', '')

def init_firebase():
    """Inicializa o Firebase Admin SDK."""
    if firebase_admin._apps:
        return firestore.client()

    if not FIREBASE_SERVICE_ACCOUNT:
        print("⚠️ Variável FIREBASE_SERVICE_ACCOUNT não configurada.")
        return None

    try:
        # Se for caminho de arquivo existente
        if os.path.exists(FIREBASE_SERVICE_ACCOUNT):
            cred = credentials.Certificate(FIREBASE_SERVICE_ACCOUNT)
        else:
            # Se for string JSON passada via GitHub Secrets / env
            cred_dict = json.loads(FIREBASE_SERVICE_ACCOUNT)
            cred = credentials.Certificate(cred_dict)
            
        firebase_admin.initialize_app(cred)
        print("✅ Firebase Admin SDK inicializado com sucesso!")
        return firestore.client()
    except Exception as e:
        print(f"❌ Erro ao inicializar Firebase: {e}")
        return None

def head(username, password):
    print("Iniciando Playwright para capturar Token e Cookies...")
    
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-accelerated-2d-canvas",
                "--no-first-run",
                "--no-zygote",
                "--disable-gpu"
            ]
        )
        context = browser.new_context(
            ignore_https_errors=True,
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        )
        page = context.new_page()

        captured = {"token": None}

        def handle_request(request):
            if "pesquisapreco" in request.url:
                headers = request.headers
                if "authorization" in headers:
                    captured["token"] = headers["authorization"]

        page.on("request", handle_request)

        try:
            # 1. Login no portal SEFAZ-MT Nota MT
            print("Acessando página de autenticação...")
            page.goto("https://www.sefaz.mt.gov.br/notamt/inicio", timeout=60000)
            page.wait_for_selector('#mat-input-0', timeout=30000)
            page.fill('#mat-input-0', username)
            page.fill('#mat-input-1', password)
            
            with page.expect_response(lambda res: "/api/autenticacao/login" in res.url, timeout=30000):
                page.keyboard.press("Enter")
            
            time.sleep(2)

            # 2. Navega para a pesquisa para consolidar cookies de telemetria
            print("Acessando página do Menor Preço...")
            page.goto("https://www.sefaz.mt.gov.br/notamt/menorpreco/pesquisa", timeout=60000)
            page.wait_for_load_state("networkidle", timeout=30000)
            time.sleep(2)

            # 3. Captura dos Cookies da Sessão
            cookies_list = context.cookies()
            cookie_string = "; ".join([f"{c['name']}={c['value']}" for c in cookies_list])
            
            browser.close()
            print("✅ Token e Cookies capturados com sucesso!")
            return captured["token"], cookie_string
            
        except Exception as e:
            browser.close()
            raise Exception(f"Falha durante a autenticação no Playwright: {e}")

def classificar(prod):
    if not prod:
        return None
    prod = str(prod).upper()
    if "ETANOL" in prod:
        return "ETANOL"
    elif "GASOLINA" in prod and "ADIT" in prod:
        return "GASOLINA ADITIVADA"
    elif "GASOLINA" in prod:
        return "GASOLINA"
    elif "DIESEL" in prod and ("S10" in prod or "S-10" in prod):
        return "DIESEL S10"
    elif "DIESEL" in prod and ("S500" in prod or "S-500" in prod or "COMUM" in prod):
        return "DIESEL S500"
    elif "FILTRO" in prod:
        return "FILTRO"
    return None

def salvar_firestore(df, db):
    if not db:
        print("⚠️ Conexão com Firestore não disponível. Pulando salvamento.")
        return

    print(f"Iniciando gravação no Google Cloud Firestore...")
    try:
        collection_ref = db.collection('precos')
        
        # Firestore permite no máximo 500 operações por batch
        batch_size = 400
        total_records = len(df)
        
        for i in range(0, total_records, batch_size):
            batch = db.batch()
            chunk = df.iloc[i:i + batch_size]
            
            for _, row in chunk.iterrows():
                doc_id = str(row["id"])
                doc_ref = collection_ref.document(doc_id)
                
                doc_data = {
                    "id": doc_id,
                    "nome_emissor": str(row["nomeEmissor"]).strip(),
                    "desc_produto": str(row["descProduto"]),
                    "valor_unidade_comercial": float(row["valorUnidadeComercial"]),
                    "nome_municipio_emissor": str(row["nomeMunicipioEmissor"]).strip().upper(),
                    "latitude": float(row["latitudeEstabelecimento"]) if pd.notnull(row["latitudeEstabelecimento"]) else None,
                    "longitude": float(row["longitudeEstabelecimento"]) if pd.notnull(row["longitudeEstabelecimento"]) else None,
                    "distancia": float(row["distancia"]) if pd.notnull(row["distancia"]) else 0.0,
                    "data_emissao": str(row["dataEmissao_dt"]),
                    "atualizado_em": firestore.SERVER_TIMESTAMP
                }
                
                batch.set(doc_ref, doc_data, merge=True)
            
            batch.commit()
            print(f"📦 Batch gravado: {min(i + batch_size, total_records)}/{total_records} documentos.")

        print(f"✅ Todos os {total_records} registros foram sincronizados com o Firestore!")
    except Exception as e:
        print(f"❌ Erro ao salvar no Firestore: {e}")
        raise e

def job():
    print(f"\n==================================================")
    print(f"Iniciando Coleta Menor Preço SEFAZ-MT: {datetime.now().strftime('%d/%m/%Y %H:%M:%S')}")
    print(f"==================================================")
    
    db = init_firebase()

    auth_val, cookie_string = head(SEFAZ_USERNAME, SEFAZ_PASSWORD)
    
    if not auth_val:
        raise Exception("Não foi possível capturar o token de autorização da SEFAZ.")

    bearer_token = auth_val.split(" ")[1] if " " in auth_val else auth_val
    produtos = ["etanol", "gasolina", "diesel"]
    url = "https://www.sefaz.mt.gov.br/notamt/api/pesquisapreco/v1"

    headers = {
        'Accept': 'application/json, text/plain, */*',
        'Authorization': f'Bearer {bearer_token}',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Cookie': cookie_string or ""
    }

    cidades = [
        {"codigo": 5107040, "nome": "PRIMAVERA DO LESTE", "lat": -15.552, "lon": -54.283},
        {"codigo": 5108402, "nome": "VARZEA GRANDE", "lat": -15.631, "lon": -56.177},
        {"codigo": 5103403, "nome": "CUIABA", "lat": -15.600, "lon": -56.096},
        {"codigo": 5101803, "nome": "BARRA DO GARCAS", "lat": -15.891, "lon": -52.261},
        {"codigo": 5107925, "nome": "SORRISO", "lat": -12.546, "lon": -55.726},
        {"codigo": 5103353, "nome": "CONFRESA", "lat": -10.657, "lon": -51.570},
        {"codigo": 5101902, "nome": "BRASNORTE", "lat": -12.125, "lon": -58.006},
        {"codigo": 5107602, "nome": "RONDONOPOLIS", "lat": -16.467, "lon": -54.636},
        {"codigo": 5107909, "nome": "SINOP", "lat": -11.860, "lon": -55.509}
    ]

    dfs = []
    meses = {"Jan":"01","Feb":"02","Mar":"03","Apr":"04","May":"05","Jun":"06",
             "Jul":"07","Aug":"08","Sep":"09","Oct":"10","Nov":"11","Dec":"12"}

    for cidade in cidades:
        print(f"🔎 Consultando {cidade['nome']}...")
        for produto in produtos:
            payload = {
                "pesquisa": produto,
                "codigoMunicipio": cidade["codigo"],
                "quantidadeRegistros": 1000,
                "pagina": 0,
                "latitude": cidade["lat"],
                "longitude": cidade["lon"],
                "raioPesquisa": 100
            }

            try:
                response = requests.post(url, headers=headers, json=payload, timeout=30)
                if response.status_code == 200:
                    df = pd.read_json(StringIO(response.text))
                    if df.empty:
                        continue
                    
                    # Tratamento de datas
                    df["dataEmissao"] = df["dataEmissao"].astype(str).str.replace("AMT", "", regex=False).str.strip()
                    df_split = df["dataEmissao"].str.split(" ", expand=True)
                    
                    if df_split.shape[1] >= 6:
                        df["datetime_str"] = df_split[5] + "-" + df_split[1].map(meses) + "-" + df_split[2] + " " + df_split[3]
                        df["dataEmissao_dt"] = pd.to_datetime(df["datetime_str"], format="%Y-%m-%d %H:%M:%S", errors="coerce")
                    else:
                        df["dataEmissao_dt"] = pd.to_datetime(df["dataEmissao"], errors="coerce")
                    
                    df = df.dropna(subset=["dataEmissao_dt"])
                    
                    # Filtra últimos 30 dias
                    df = df[df["dataEmissao_dt"] >= pd.Timestamp.now() - pd.Timedelta(days=30)]
                    df = df[df["descProduto"].astype(str).str.contains(produto, case=False, na=False)]
                    df['descProduto'] = df['descProduto'].apply(classificar)
                    df = df.dropna(subset=["descProduto"])
                    
                    dfs.append(df)
                time.sleep(0.4)
            except Exception as ex:
                print(f"⚠️ Erro ao consultar {cidade['nome']} - {produto}: {ex}")

    if not dfs:
        print("ℹ️ Nenhum dado novo encontrado nesta rodada.")
        return

    df_final = pd.concat(dfs, ignore_index=True)
    
    # Criação da Chave Primária (ID)
    df_final['timestamp'] = pd.to_datetime(df_final['dataEmissao_dt']).view("int64") // 10**9
    df_final['id'] = df_final['timestamp'].astype(str) + df_final['numrCnpjEmissor'].astype(str) + df_final['descProduto'].astype(str).str[:2]
    df_final['nomeMunicipioEmissor'] = df_final['nomeMunicipioEmissor'].astype(str).str.upper()

    df_clean = df_final[['id', 'nomeEmissor', 'descProduto', 'valorUnidadeComercial', 
                          'nomeMunicipioEmissor', 'latitudeEstabelecimento', 'longitudeEstabelecimento', 
                          'distancia', 'dataEmissao_dt']].drop_duplicates(subset=['id'])

    print(f"📊 Processamento concluído! Total de {len(df_clean)} registros únicos.")

    # Salva diretamente no Firebase Firestore
    salvar_firestore(df_clean, db)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Scraper Menor Preço SEFAZ-MT com Firebase Firestore")
    parser.add_argument("--loop", action="store_true", help="Executa em loop contínuo a cada 8 horas (modo local)")
    args = parser.parse_args()

    if args.loop:
        import schedule
        print("🔁 Modo agendado ativado. Executando primeira rodada...")
        job()
        schedule.every(8).hours.do(job)
        while True:
            schedule.run_pending()
            time.sleep(60)
    else:
        # Modo CI/CD padrão (GitHub Actions)
        job()
