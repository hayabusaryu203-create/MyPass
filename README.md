# MaPass

Guarda os padrões de desbloqueio que você já tentou, para não repetir, e deixa um contato te ajudar:
você pede socorro, a pessoa desenha o padrão que acha que é, você testa no celular e responde se deu certo.

Site estático (HTML/JS, sem build) + [Supabase](https://supabase.com) para login, banco e tempo real.

## Configuração (uma vez só)

1. **Crie um projeto no Supabase** (plano grátis serve).
2. **Banco:** no painel, abra *SQL Editor*, cole todo o conteúdo de `supabase/schema.sql` e clique em *Run*.
3. **Chaves:** em *Project Settings → API* (ou *API Keys*), copie a *Project URL* e a chave *anon* / *publishable*
   e cole em `config.js`. Essa chave é pública de propósito; quem protege os dados são as regras do `schema.sql`.
4. **Login por e-mail:** em *Authentication → Sign In / Providers → Email*, escolha:
   - desligar *Confirm email*, para criar conta e já entrar; ou
   - deixar ligado e, depois do deploy, colocar o endereço da Vercel em *Authentication → URL Configuration → Site URL*,
     para o link de confirmação voltar para o site certo.

## Deploy na Vercel

Na pasta do projeto:

```sh
npx vercel        # primeira vez: aceite os padrões (framework "Other", sem build)
npx vercel --prod
```

Ou suba a pasta para um repositório no GitHub e importe na Vercel. Não precisa de variáveis de ambiente.

## Como usar

- **Tentar:** desenhe o padrão antes de testar no celular. Se já tentou, o app avisa. Arraste os cards do
  histórico para agrupar os parecidos.
- **Contatos:** cada pessoa cria sua conta e uma adiciona a outra pelo e-mail (vale para os dois lados).
- **Socorro:** peça ajuda a um contato. A pessoa recebe o pedido na aba Socorro, desenha e envia. Você testa e clica em
  *Deu certo* ou *Não deu*. O que não deu entra automaticamente no seu histórico, e a pessoa vê a resposta na hora
  e também enxerga o que você já tentou, para não mandar repetido.
- **Avisos:** com a página aberta, chegam avisos na tela. Clique em "Ativar avisos" para receber notificação do navegador
  quando a aba estiver em segundo plano (funciona no PC; no celular depende do navegador).

## Histórico da versão antiga

A versão anterior guardava tudo só no navegador. Abra este `index.html` no mesmo navegador em que usava a versão antiga
(abrindo o arquivo direto, não pelo endereço da Vercel), entre na sua conta e clique em *Importar* no aviso que aparece.
Ou use *Exportar* na versão antiga e *Importar* aqui.
