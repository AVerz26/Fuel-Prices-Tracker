import os
import json
import pandas as pd
import numpy as np

def processar():
    csv_path = "prices(1).csv"
    if not os.path.exists(csv_path):
        csv_path = r"C:\Users\andreva\Downloads\menor-preco-sefaz-mt\prices(1).csv"
    if not os.path.exists(csv_path):
        csv_path = r"C:\Users\andreva\Downloads\prices.csv"

    print(f"[OK] Lendo dataset completo: {csv_path}...")
    df = pd.read_csv(csv_path)
    total_linhas = len(df)
    print(f"[OK] Total de registros lidos: {total_linhas}")

    # 1. Normalização de combustíveis
    def normalizar_combustivel(prod):
        if pd.isna(prod): return None
        p = str(prod).upper().strip()
        if "ETANOL" in p: return "ETANOL"
        elif "GASOLINA" in p and "ADIT" in p: return "GASOLINA ADITIVADA"
        elif "GASOLINA" in p: return "GASOLINA"
        elif "DIESEL" in p and ("S10" in p or "S-10" in p): return "DIESEL S10"
        elif "DIESEL" in p and ("S500" in p or "S-500" in p or "COMUM" in p): return "DIESEL S500"
        return None

    df['descProduto'] = df['descProduto'].apply(normalizar_combustivel)
    df = df.dropna(subset=['descProduto'])

    # 2. Tratamento numérico e remoção de outliers
    df['valor'] = pd.to_numeric(df['valorUnidadeComercial'], errors='coerce')
    df = df.dropna(subset=['valor'])

    # Filtros de limites realistas de mercado
    limites = {
        'ETANOL': (2.20, 6.50),
        'GASOLINA': (3.80, 8.50),
        'GASOLINA ADITIVADA': (3.80, 9.20),
        'DIESEL S10': (4.20, 8.90),
        'DIESEL S500': (4.00, 8.50)
    }

    condicoes = []
    for fuel, (vmin, vmax) in limites.items():
        cond = (df['descProduto'] == fuel) & (df['valor'] >= vmin) & (df['valor'] <= vmax)
        condicoes.append(cond)
    
    filtro_valido = pd.concat(condicoes, axis=1).any(axis=1)
    df = df[filtro_valido]

    # 3. Tratamento de datas
    df['data'] = pd.to_datetime(df['dataEmissao_dt'], errors='coerce')
    df = df.dropna(subset=['data'])
    df = df.sort_values(by='data', ascending=False)

    df['data_dia'] = df['data'].dt.strftime('%Y-%m-%d')
    df['municipio'] = df['nomeMunicipioEmissor'].astype(str).str.strip().str.upper()
    df['nomeEmissor'] = df['nomeEmissor'].astype(str).str.strip().str.upper()

    print(f"[OK] Registros validos e higienizados: {len(df)}")

    # 4. Agregações para Séries Temporais Diárias (100% de todo o histórico)
    grouped = df.groupby(['data_dia', 'descProduto'])['valor'].agg(['mean', 'min', 'max', 'count']).reset_index()
    
    timeline = {}
    for _, row in grouped.iterrows():
        dia = str(row['data_dia'])
        fuel = str(row['descProduto'])
        if dia not in timeline:
            timeline[dia] = {}
        timeline[dia][fuel] = {
            'media': round(float(row['mean']), 2),
            'min': round(float(row['min']), 2),
            'max': round(float(row['max']), 2),
            'qtd': int(row['count'])
        }

    # 5. Postos Únicos mais recentes para o Mapa Interativo de MT
    df_postos = df.dropna(subset=['latitudeEstabelecimento', 'longitudeEstabelecimento']).copy()
    df_postos['lat'] = df_postos['latitudeEstabelecimento'].round(4)
    df_postos['lon'] = df_postos['longitudeEstabelecimento'].round(4)

    # Mantém apenas a leitura mais recente de cada posto por combustível
    df_postos_unicos = df_postos.drop_duplicates(subset=['nomeEmissor', 'lat', 'lon', 'descProduto'], keep='first')

    postos_lista = []
    for _, row in df_postos_unicos.iterrows():
        postos_lista.append({
            'id': str(row['id']),
            'nome_emissor': str(row['nomeEmissor']),
            'desc_produto': str(row['descProduto']),
            'valor': round(float(row['valor']), 2),
            'municipio': str(row['municipio']),
            'latitude': float(row['latitudeEstabelecimento']),
            'longitude': float(row['longitudeEstabelecimento']),
            'distancia': round(float(row['distancia']), 1) if pd.notnull(row.get('distancia')) else 0.0,
            'data_emissao': str(row['dataEmissao_dt'])
        })

    # 6. Dados consolidados de todas as cidades
    cidades_sumario = {}
    for cid, g_cid in df.groupby('municipio'):
        cidades_sumario[str(cid)] = {
            'total_registros': len(g_cid),
            'media_gasolina': round(float(g_cid[g_cid['descProduto'] == 'GASOLINA']['valor'].mean()), 2) if len(g_cid[g_cid['descProduto'] == 'GASOLINA']) > 0 else None,
            'media_etanol': round(float(g_cid[g_cid['descProduto'] == 'ETANOL']['valor'].mean()), 2) if len(g_cid[g_cid['descProduto'] == 'ETANOL']) > 0 else None,
            'media_diesel': round(float(g_cid[g_cid['descProduto'] == 'DIESEL S10']['valor'].mean()), 2) if len(g_cid[g_cid['descProduto'] == 'DIESEL S10']) > 0 else None,
        }

    # 7. Salva o arquivo JSON consolidado
    os.makedirs('docs/data', exist_ok=True)
    out_file = 'docs/data/historico_completo.json'
    
    # Amostra recente de todos os postos de MT (até 4000 postos únicos)
    payload = {
        'total_registros_processados': total_linhas,
        'total_registros_validos': len(df),
        'dias_historico': len(timeline),
        'postos_mapeados': len(postos_lista),
        'timeline': timeline,
        'postos': postos_lista,
        'cidades': cidades_sumario
    }

    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=None)

    # Cria também a lista completa de postos em docs/data/precos.json
    with open('docs/data/precos.json', 'w', encoding='utf-8') as f:
        json.dump(postos_lista, f, ensure_ascii=False, indent=None)

    print(f"[SUCESSO] Arquivo salvo em {out_file} ({os.path.getsize(out_file) / 1024:.1f} KB)!")
    print(f"[SUCESSO] Total de {len(timeline)} dias de historico consolidados.")
    print(f"[SUCESSO] Total de {len(postos_lista)} postos unicos mapeados em MT.")

if __name__ == "__main__":
    processar()
