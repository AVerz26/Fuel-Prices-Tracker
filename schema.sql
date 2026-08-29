-- ==========================================================
-- Schema para Banco de Dados do Menor Preço (Supabase / PostgreSQL)
-- Com Segurança em Nível de Linha (Row-Level Security - RLS)
-- ==========================================================

-- 1. Criação da Tabela de Preços
CREATE TABLE IF NOT EXISTS precos (
    id VARCHAR(100) PRIMARY KEY,
    nome_emissor VARCHAR(255) NOT NULL,
    desc_produto VARCHAR(100) NOT NULL,
    valor_unidade_comercial NUMERIC(10, 3) NOT NULL,
    nome_municipio_emissor VARCHAR(100) NOT NULL,
    latitude NUMERIC(10, 6),
    longitude NUMERIC(10, 6),
    distancia NUMERIC(10, 2),
    data_emissao TIMESTAMP NOT NULL,
    criado_em TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Índices de Otimização
CREATE INDEX IF NOT EXISTS idx_precos_produto ON precos (desc_produto);
CREATE INDEX IF NOT EXISTS idx_precos_municipio ON precos (nome_municipio_emissor);
CREATE INDEX IF NOT EXISTS idx_precos_data ON precos (data_emissao DESC);
CREATE INDEX IF NOT EXISTS idx_precos_valor ON precos (valor_unidade_comercial ASC);

-- 3. Trigger para atualização automática da coluna atualizado_em
CREATE OR REPLACE FUNCTION update_atualizado_em_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.atualizado_em = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_precos_atualizado_em ON precos;
CREATE TRIGGER update_precos_atualizado_em
    BEFORE UPDATE ON precos
    FOR EACH ROW
    EXECUTE FUNCTION update_atualizado_em_column();

-- ==========================================================
-- 4. CONFIGURAÇÃO DE SEGURANÇA (ROW-LEVEL SECURITY - RLS)
-- ==========================================================

-- Habilita RLS na tabela (Impede qualquer acesso anônimo sem autorização)
ALTER TABLE precos ENABLE ROW LEVEL SECURITY;

-- Política 1: Apenas usuários autenticados (logados com email/senha) podem LER os dados
DROP POLICY IF EXISTS "Leitura apenas para usuarios autenticados" ON precos;
CREATE POLICY "Leitura apenas para usuarios autenticados"
ON precos
FOR SELECT
TO authenticated
USING (true);

-- Política 2: O GitHub Actions (usando a conexão Postgres direta ou Service Role) pode INSERIR e ATUALIZAR dados
DROP POLICY IF EXISTS "Escrita apenas para service_role ou postgres" ON precos;
CREATE POLICY "Escrita apenas para service_role ou postgres"
ON precos
FOR ALL
TO service_role
USING (true);
