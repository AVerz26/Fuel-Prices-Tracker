import time
import json
import requests
import os
import sys
import argparse
from datetime import datetime
import pandas as pd
from io import StringIO
from sqlalchemy import create_engine, text
from playwright.sync_api import sync_playwright
from dotenv import load_dotenv

# Carrega variáveis de ambiente de um arquivo .env se existir
load_dotenv()

# Configurações de Credenciais e Conexão com Supabase / PostgreSQL
SEFAZ_USERNAME = os.getenv('SEFAZ_USERNAME', '45812131856')
SEFAZ_PASSWORD = os.getenv('SEFAZ_PASSWORD', 'g80y5vxb8w')
DATABASE_URL = os.getenv('DATABASE_URL', '') # Ex: postgresql+psycopg2://postgres.xxxx:senha@aws-0-sa-east-1.pooler.supabase.com:6543/postgres

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
        return "GASOLINA COMUM"
    elif "DIESEL" in prod and ("S10" in prod or "S-10" in prod):
        return "DIESEL S10"
    elif "DIESEL" in prod and ("S500" in prod or "S-500" in prod or "COMUM" in prod):
        return "DIESEL S500"
    elif "FILTRO" in prod:
        return "FILTRO"
    return None

def salvar_supabase(df, db_url):
    if not db_url:
        print("⚠️ DATABASE_URL não configurada. Configure a conexão no .env ou nos GitHub Secrets.")
        return

    print("Iniciando gravação segura no banco de dados (Supabase / PostgreSQL)...")
    try:
        # Se o prefixo for postgres:// converte para postgresql+psycopg2:// para SQLAlchemy
        if db_url.startswith("postgres://"):
            db_url = db_url.replace("postgres://", "postgresql+psycopg2://", 1)
        elif db_url.startswith("postgresql://") and not db_url.startswith("postgresql+"):
            db_url = db_url.replace("postgresql://", "postgresql+psycopg2://", 1)

        engine = create_engine(db_url, pool_pre_ping=True)

        # Query Postgres UPSERT (Supabase)
        query = text("""
            INSERT INTO precos (
                id, nome_emissor, desc_produto, valor_unidade_comercial, 
                nome_municipio_emissor, latitude, longitude, distancia, data_emissao
            )
            VALUES (
                :id, :nome_emissor, :desc_produto, :valor_unidade_comercial, 
                :nome_municipio_emissor, :latitude, :longitude, :distancia, :data_emissao
            )
            ON CONFLICT (id) DO UPDATE SET
                valor_unidade_comercial = EXCLUDED.valor_unidade_comercial,
                data_emissao = EXCLUDED.data_emissao,
                atualizado_em = NOW();
        """)

        records_to_insert = []
        for _, row in df.iterrows():
            records_to_insert.append({
                "id": str(row["id"]),
                "nome_emissor": str(row["nomeEmissor"]),
                "desc_produto": str(row["descProduto"]),
                "valor_unidade_comercial": float(row["valorUnidadeComercial"]),
                "nome_municipio_emissor": str(row["nomeMunicipioEmissor"]),
                "latitude": float(row["latitudeEstabelecimento"]) if pd.notnull(row["latitudeEstabelecimento"]) else None,
                "longitude": float(row["longitudeEstabelecimento"]) if pd.notnull(row["longitudeEstabelecimento"]) else None,
                "distancia": float(row["distancia"]) if pd.notnull(row["distancia"]) else 0.0,
                "data_emissao": row["dataEmissao_dt"]
            })

        with engine.begin() as conn:
            for record in records_to_insert:
                conn.execute(query, record)

        print(f"✅ Gravado no Supabase com sucesso! Total de {len(records_to_insert)} registros atualizados.")
    except Exception as e:
        print(f"❌ Erro ao salvar no banco de dados: {e}")
        raise e

def job():
    print(f"\n==================================================")
    print(f"Iniciando Coleta Menor Preço SEFAZ-MT: {datetime.now().strftime('%d/%m/%Y %H:%M:%S')}")
    print(f"==================================================")
    
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

    # Salva diretamente no Supabase / PostgreSQL (sem salvar arquivos de dados no repositório)
    salvar_supabase(df_clean, DATABASE_URL)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Scraper Menor Preço SEFAZ-MT com Supabase")
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
