# MTM · Setup Firebase (5 minutos)

Este guia conecta seu MTM ao Firebase para que **toda a equipe edite os mesmos projetos em tempo real**, em qualquer dispositivo (desktop, tablet, celular).

> Enquanto o Firebase não estiver configurado, o app **continua funcionando offline** (modo localStorage, só este dispositivo). Você não perde nada — só não tem sincronização.

---

## 1. Criar projeto no Firebase

1. Abra https://console.firebase.google.com
2. Clique em **"Adicionar projeto"** → dê um nome (ex: `mtm-engenharia`) → continue
3. Pode **desabilitar** o Google Analytics (não precisa) → criar

## 2. Habilitar Authentication

1. No menu lateral: **Build → Authentication → Get started**
2. Aba **Sign-in method** → habilite:
   - **Email/senha** (obrigatório)
   - **Google** (opcional — habilita o botão "Continuar com Google")

## 3. Habilitar Firestore Database

1. No menu lateral: **Build → Firestore Database → Create database**
2. Escolha **"Iniciar em modo de produção"**
3. Selecione a região mais próxima:
   - **southamerica-east1** (São Paulo) — recomendado pra Brasil
4. Concluir

## 4. Colar as regras de segurança

1. No Firestore, abra a aba **Rules**
2. Apague o conteúdo todo
3. Cole o conteúdo do arquivo `firestore.rules` (vem junto neste pacote)
4. Clique **Publicar**

## 5. Pegar as credenciais do app

1. Engrenagem ⚙️ no topo esquerdo → **Configurações do projeto**
2. Role até **Seus apps** → ícone **`</>`** (web)
3. Dê um apelido qualquer (ex: `MTM Web`) → **Registrar app** (não precisa hospedar)
4. Aparece um bloco assim:

   ```js
   const firebaseConfig = {
     apiKey: "AIzaSy...",
     authDomain: "mtm-engenharia.firebaseapp.com",
     projectId: "mtm-engenharia",
     storageBucket: "mtm-engenharia.appspot.com",
     messagingSenderId: "1234567890",
     appId: "1:1234567890:web:abc..."
   };
   ```

## 6. Colar no `index.html`

Abra o `index.html` no seu editor e encontre este bloco (logo abaixo do `<head>`, perto da linha 1647):

```html
<script>
window.FIREBASE_CONFIG = {
  apiKey:            "COLE_AQUI_SEU_API_KEY",
  authDomain:        "SEU_PROJETO.firebaseapp.com",
  ...
};
</script>
```

Substitua pelos valores do passo anterior. Salve.

## 7. Autorizar o domínio (se for hospedar)

Se for abrir o app pelo **arquivo direto** (`file://...`) ou pelo `localhost`, já funciona.
Se for hospedar em um site (ex: `meudominio.com`):

1. Firebase Console → **Authentication → Settings → Authorized domains**
2. Adicione o domínio

## 8. Pronto

Abra o `index.html` no navegador:

1. Crie uma conta → faz login automaticamente
2. **Crie um workspace** (ex: "Engenharia Planta SP") → o sistema gera um **código de convite** (6 letras)
3. Compartilhe esse código com sua equipe
4. Eles criam conta e usam **"Entrar com código"** → todos editam juntos em tempo real

## Como funciona o sync

- **Status no topo:** 🟢 sincronizado · 🟡 enviando · 🟠 offline
- **Offline:** o app continua funcionando; quando voltar a conexão, sincroniza automaticamente
- **Conflitos:** quem salvar por último ganha (last-write-wins). Como o app salva por linha/projeto, conflitos reais são raros
- **Trocar workspace:** menu do usuário (canto direito) → "Trocar workspace"
- **Sair:** menu do usuário → "Sair"

## Mobile

- Funciona em qualquer navegador moderno (Safari iOS, Chrome Android)
- Toolbar com scroll horizontal, ícones em vez de labels (mais espaço pra trabalhar)
- Pode adicionar à tela inicial como app (PWA básico: tem `theme-color` e `apple-mobile-web-app-capable`)

## Custos

Firebase tem um plano gratuito generoso (Spark):
- **50 mil leituras + 20 mil escritas + 20 mil deleções por dia** no Firestore
- **1 GiB de storage**
- Autenticação ilimitada

Para uma equipe de 5–20 engenheiros editando folhas MTM, o plano gratuito sobra. Só passa se você tiver dezenas de milhares de linhas atualizadas constantemente.

## Troubleshooting

**"Firebase não configurado — rodando em modo offline"**
→ Você ainda não colou as credenciais no passo 6, ou tem placeholder (`COLE_AQUI_SEU_API_KEY`).

**"Permission denied"**
→ As regras do Firestore não foram coladas (passo 4) ou você não está logado.

**Quero ver os dados crus**
→ Firebase Console → Firestore Database → aba **Data** → veja a árvore `/workspaces/{id}/sheets/...`

**Quero remover alguém da equipe**
→ Firestore Console → workspace doc → campo `members` → delete o `uid` da pessoa

**Estou no celular e o teclado dá zoom estranho**
→ Já tratado: inputs usam `font-size:16px` em mobile (regra padrão do iOS pra não dar zoom).
