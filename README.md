# ⛽ Menor Preço MT | Fuel Prices Tracker (Firebase Edition)

Pipeline automatizado de coleta de preços de combustíveis da **SEFAZ-MT (Nota MT)** via **Playwright**, armazenamento em nuvem gratuito no **Google Firebase Firestore** com autenticação **Google 1-Clique** e publicação do dashboard no **GitHub Pages** com mapa interativo **Leaflet.js**, histórico temporal e análise de paridade etanol x gasolina.

---

## 🌟 Recursos Principais

- 🤖 **Web Scraping Automatizado**: Playwright em modo headless para 9 municípios polo de MT a cada 6 horas via GitHub Actions.
- 🔥 **Banco de Dados Google Cloud Firestore**: Armazenamento 100% gratuito e em tempo real.
- 🔒 **Autenticação Segura (Google / E-mail)**: Acesso aos dados bloqueado para visitantes não autorizados através de **Firestore Security Rules**.
- 🗺️ **Mapa Interativo (Leaflet.js)**: Postos geolocalizados com marcadores coloridos por faixa de preço e botão para traçar rota no Google Maps.
- 📈 **Gráfico de Evolução Temporal**: Histórico de preços médios por combustível.
- ⚖️ **Card & Gráfico de Paridade Etanol / Gasolina**: Aplicação automática da **Regra dos 70%**.
- 🛡️ **Zero Dados no Git**: Nenhum arquivo com dados sensíveis é salvo no repositório.

---

## 🚀 Passo a Passo de Configuração (Firebase)

### 1. Criar o Projeto no Firebase (Gratuito)
1. Acesse o [Console do Firebase](https://console.firebase.google.com/) e crie um novo projeto (ex: `menor-preco-mt`).
2. No menu lateral, acesse **Firestore Database** > **Criar banco de dados** (selecione o local `southamerica-east1` em SP).
3. Na aba **Regras (Rules)** do Firestore, cole o conteúdo do arquivo [`firestore.rules`](./firestore.rules) e clique em **Publicar**.

### 2. Ativar a Autenticação (Google Login)
1. No menu lateral, acesse **Authentication** > **Começar**.
2. Na aba **Sign-in method**, ative o provedor **Google** (e se desejar, **E-mail/senha**).

### 3. Gerar a Chave para o GitHub Actions (Scraper)
1. No console do Firebase, clique no ícone de engrenagem ⚙️ **Project Settings** (Configurações do projeto) > **Service accounts** (Contas de serviço).
2. Clique no botão **Generate new private key** (Gerar nova chave privada).
3. Um arquivo `.json` será baixado no seu computador.
4. Abra esse arquivo `.json`, copie todo o seu conteúdo de texto.
5. No seu repositório no GitHub, acesse **Settings** > **Secrets and variables** > **Actions** > **New repository secret**:
   - Nome: `FIREBASE_SERVICE_ACCOUNT`
   - Valor: *(Cole todo o conteúdo do arquivo .json)*

### 4. Configurar as Outras Secrets no GitHub
Adicione também os segredos da SEFAZ:
- `SEFAZ_USERNAME`: Seu CPF ou usuário da SEFAZ-MT.
- `SEFAZ_PASSWORD`: Sua senha do portal Nota MT.

### 5. Configurar o Web App no Frontend (`docs/config.js`)
1. No Firebase > ⚙️ **Project Settings** > aba **Geral**, role até **Seus aplicativos** e clique no ícone **Web (</>)**.
2. Registre o app (ex: `Menor Preço Web`) e copie as chaves do `firebaseConfig`.
3. Cole as chaves no arquivo [`docs/config.js`](./docs/config.js) ou insira na tela de login pelo botão de configurações.

---

## 🏃 Como Rodar Localmente

```bash
# 1. Instalar dependências
pip install -r requirements.txt
playwright install chromium

# 2. Executar coleta
python menor_preco_playwright.py

# 3. Testar a página web
python -m http.server 8000 --directory docs
```
Abra `http://localhost:8000` no seu navegador.
