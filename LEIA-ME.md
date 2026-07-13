# MTM em Foco — recuperar dados do Firestore e continuar salvando

Este pacote faz o app **recuperar os seus dados que estão no Cloud Firestore** (coleções
`projects`, `sheets`, `logos`) e **continuar salvando** de volta no mesmo formato.

## Arquivos para subir no GitHub (mesma pasta)
- `index.html`
- `firebase-mtm.js`  ← **mesmo nome, com hífen**

Suba os dois juntos (Add file → Upload files → Commit). O `index.html` já carrega o módulo
com `?v=3` para evitar cache antigo.

## Passo 1 — Regras do FIRESTORE (é aqui que está travando a leitura)
Seus dados estão no **Cloud Firestore**, e as regras dele estão bloqueando a leitura
(erro "Missing or insufficient permissions"). Corrija assim:

1. Console do Firebase → **Firestore Database** → aba **Regras (Rules)**.
   (ATENÇÃO: é o **Firestore**, NÃO o Realtime Database.)
2. Apague tudo e cole **exatamente** isto (sintaxe do Firestore):

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}
```

3. Clique em **Publicar**.

> Não confunda com o Realtime Database. A regra do Realtime é JSON (`{ "rules": ... }`).
> A do Firestore é essa acima (`rules_version = '2'; service cloud.firestore ...`).
> As regras do Realtime Database podem continuar como estão — não usamos mais o Realtime.

## Passo 2 — Login anônimo
Console → **Authentication** → **Sign-in method** → **Anonymous** → **Ativar**.
(No seu projeto já está ativo — vimos os usuários anônimos.)

## Passo 3 — Limpar cache e testar
Abra o site com **Ctrl+Shift+R** ou em **janela anônima** (Ctrl+Shift+N).

## Como confirmar que funcionou (F12 → Console)
Procure as linhas `[MTM Firebase] ...`:
- ✅ `Funções locais conectadas ao Firestore.`
- ✅ `Dados recuperados do Firestore: X folha(s), Y pasta(s), Z logo(s).`
  → Suas empresas/projetos/folhas devem aparecer na tela.
- ❌ `sem permissão para ler os dados` → falta publicar as regras do **Firestore** (Passo 1).
- ❌ Linhas dizendo apenas "Realtime Database" → é o arquivo antigo/cache (refaça upload + Ctrl+Shift+R).

## Proteções embutidas (para não perder dados)
- O app **só habilita o salvamento DEPOIS de ler os dados com sucesso**. Se a leitura falhar
  (regras bloqueadas), ele **não salva** — assim não sobrescreve o que está na nuvem.
- Ao salvar, grava **apenas o que mudou** (cada folha/pasta/logo alterado) e **não faz remoção
  em massa** se a lista local vier vazia por engano.

## Segurança
- A `apiKey` do Firebase Web é pública por natureza; a proteção real vem das **regras**.
- Se usar `allow read, write: if true;` (aberto a qualquer um) é só para teste — volte para
  `if request.auth != null;` depois.

## Se der erro de import do SDK
A versão usada é **10.12.2** (nas 3 primeiras linhas do `firebase-mtm.js`). Se aparecer erro de
`import` do gstatic no Console, troque o número (ex.: `10.13.0`).
