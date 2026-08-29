#  Menor Preço SEFAZ-MT | Pipeline Seguro (GitHub Actions + Supabase + GitHub Pages)

Pipeline automatizado de Web Scraping para monitoramento contínuo dos preços de combustíveis (Etanol, Gasolina Comum, Gasolina Aditivada, Diesel S10 e S500) em Mato Grosso.

---

##  Arquitetura de Segurança de Dados

-  **Zero Dados no Repositório Git**: Nenhum dado de preço é versionado ou visível no GitHub.
-  **Autenticação Obrigatória no GitHub Pages**: O acesso ao painel requer login com **E-mail e Senha** via **Supabase Auth**.
-  **Row-Level Security (RLS)**: Consultas diretas não autenticadas ao banco são bloqueadas em nível de banco de dados pelo PostgreSQL.
-  **Extração Automática com GitHub Actions**: Roda em segundo plano com Playwright Headless e salva diretamente no Supabase via credenciais seguras.

---

##  Estrutura do Projeto

```
menor-preco-sefaz-mt/
├── .github/
│   └── workflows/
│       └── scrape_and_deploy.yml   # Workflow automatizado do GitHub Actions
├── docs/                           # Aplicação Web para o GitHub Pages
│   ├── index.html                  # Interface com Tela de Login e Painel Protegido
│   ├── style.css                   # Estilização moderna Dark/Light com Glassmorphism
│   ├── config.js                   # Configuração pública das chaves do Supabase
│   └── app.js                      # Lógica de Autenticação (Supabase Auth), RLS e Charts
├── menor_preco_playwright.py       # Scraper robusto integrado ao Supabase
├── schema.sql                      # DDL do banco com políticas de RLS
├── requirements.txt                # Dependências Python
├── .gitignore                      # Protege arquivos de dados e variáveis de ambiente
└── README.md                       # Documentação do projeto
```

---

## 🚀 Guia Passo a Passo de Configuração

### 1. Criar o Banco e Ativar a Segurança no Supabase (100% Gratuito)

1. Acesse [supabase.com](https://supabase.com) e crie sua conta gratuita.
2. Crie um novo projeto (ex: `menor-preco-mt`).
3. No menu lateral, acesse **SQL Editor**, cole todo o conteúdo do arquivo [`schema.sql`](./schema.sql) e clique em **Run**.
   *(Isso criará a tabela `precos` e ativará as políticas de segurança RLS)*.

---

### 2. Criar Usuários com Permissão de Acesso

No painel do Supabase:
1. Vá em **Authentication** > **Users**.
2. Clique em **Add user** > **Create user**.
3. Digite o **E-mail** e a **Senha** de quem poderá acessar o painel.
4. *Opcional: desmarque "Send invite email" se for definir a senha manualmente na hora.*

---

### 3. Configurar as Chaves no GitHub Pages (`docs/config.js`)

1. No Supabase, vá em **Project Settings** > **API**.
2. Copie os dois valores:
   - **Project URL** (ex: `https://xyzcompany.supabase.co`)
   - **anon / public key** (chave pública)
3. Abra o arquivo `docs/config.js` e cole suas chaves:
   ```javascript
   window.SUPABASE_CONFIG = {
       url: "https://seu-projeto.supabase.co",
       anonKey: "sua-anon-public-key-aqui"
   };
   ```
*(Nota: a chave `anon` é pública e segura, pois o banco só libera os dados se o usuário estiver autenticado via RLS)*.

---

### 4. Configurar os GitHub Secrets (Para a Coleta Automática)

No seu repositório no GitHub:
1. Vá em **Settings** > **Secrets and variables** > **Actions**.
2. Clique em **New repository secret** e adicione:

| Secret | Descrição |
| :--- | :--- |
| `SEFAZ_USERNAME` | Seu CPF ou usuário cadastrado na SEFAZ-MT |
| `SEFAZ_PASSWORD` | Sua senha do portal Nota MT |
| `DATABASE_URL` | URI de conexão do Supabase (obtida em **Project Settings** > **Database** > **Connection String URI**) |

---

### 5. Ativar o GitHub Pages

1. No repositório, vá em **Settings** > **Pages**.
2. Em **Build and deployment** > **Source**, selecione **GitHub Actions**.
3. Na primeira execução do workflow, a sua página segura estará no ar!

---

### 6. Executar a Coleta Manualmente

1. Vá na aba **Actions** no GitHub.
2. Selecione **Coleta Menor Preço SEFAZ-MT e Deploy Pages**.
3. Clique em **Run workflow**.
4. O GitHub Actions executará o scraper com Playwright, salvará os dados direto no Supabase e publicará a aplicação.

---

##  Execução Local (Opcional)

```bash
# 1. Instalar dependências
pip install -r requirements.txt

# 2. Instalar Chromium do Playwright
playwright install chromium

# 3. Executar uma coleta
python menor_preco_playwright.py
```
