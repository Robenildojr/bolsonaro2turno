# WhatsApp

O Gideão atende no WhatsApp com a **mesma memória** da tela. O que você começou no
computador continua no celular sem repetir contexto — é a mesma conversa, só
outro transporte.

## Decida primeiro: qual número

Esta é a escolha que define tudo, e ela é desconfortável.

| | **Cloud API** (oficial) | **Baileys** (não oficial) |
|---|---|---|
| Número | um novo, dedicado | o seu, o que já existe |
| Termos da Meta | dentro | **fora** |
| Risco de banimento | nenhum | real, e imprevisível |
| Estabilidade | alta | quebra quando a Meta muda o protocolo |
| Custo | grátis até certo volume | zero |
| Configuração | ~20 min no painel da Meta | ler um QR |

O que quase todo mundo quer é o segundo: usar o número que já tem. O problema é
que o Baileys funciona por engenharia reversa do protocolo, e a Meta bane números
que detecta. Se o número for o do seu escritório, o prejuízo de um banimento não
é o Gideão parar — é você perder o contato com os clientes.

**Recomendação:** Cloud API com um chip novo (um pré-pago barato resolve).
Você manda mensagem para esse número e ele responde. Na prática é como ter o
assistente numa conversa separada, o que costuma ser melhor mesmo.

Se ainda assim quiser o Baileys, ele está implementado e exige que você assuma o
risco explicitamente (`WHATSAPP_ACEITO_RISCO=sim`).

---

## Cloud API — passo a passo

### 1. No painel da Meta

1. Entre em <https://developers.facebook.com> e crie um app do tipo **Business**.
2. Adicione o produto **WhatsApp**.
3. Em *Configuração da API*, anote o **ID do número de telefone**
   (`WHATSAPP_PHONE_NUMBER_ID`) e gere um **token de acesso permanente**
   (`WHATSAPP_ACCESS_TOKEN`) — o token temporário de 24h serve só para testar.
4. Em *Configurações do app → Básico*, copie a **Chave secreta do app**
   (`WHATSAPP_APP_SECRET`). **Obrigatória** — sem ela o Gideão recusa subir o
   canal, e o motivo está em *Segurança*, mais abaixo.
5. Cadastre o número que vai atender.

### 2. No `.env`

```bash
WHATSAPP_ENABLED=true
WHATSAPP_PROVIDER=cloud
WHATSAPP_OWNER=5596991234567        # SEU número, em E.164 sem o +
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_ACCESS_TOKEN=...
WHATSAPP_APP_SECRET=...                 # obrigatório: é o que autentica o webhook
WHATSAPP_VERIFY_TOKEN=escolha-uma-frase-qualquer
```

`WHATSAPP_VERIFY_TOKEN` é um valor que **você inventa**. A Meta só confere se
bate com o que você cadastrar no painel.

### 3. Expor o webhook

A Meta precisa alcançar a sua máquina. O Gideão escuta em `127.0.0.1`, então é
preciso um túnel:

```bash
# desenvolvimento
npx localtunnel --port 4319
# ou, com conta:
cloudflared tunnel --url http://localhost:4319
```

No painel da Meta, cadastre:

- **URL de callback:** `https://seu-tunel/webhook/whatsapp`
- **Token de verificação:** o mesmo do `.env`
- **Campos:** assine `messages`

A Meta chama a URL uma vez para verificar. Se aparecer `webhook verificado pela
Meta` no log, está feito.

### 4. Testar

Mande "oi" do seu celular para o número cadastrado. Deve responder em segundos.

---

## Baileys — se você decidir mesmo assim

```bash
npm install @whiskeysockets/baileys
```

```bash
WHATSAPP_ENABLED=true
WHATSAPP_PROVIDER=baileys
WHATSAPP_OWNER=5596991234567
WHATSAPP_ACEITO_RISCO=sim
```

Ao subir, um QR aparece no terminal. Leia com *WhatsApp → Aparelhos conectados*.
A sessão fica em `~/.gideao/whatsapp-session` e sobrevive a reinícios.

Cuidados que reduzem (não eliminam) o risco de banimento: não use para disparo
em massa, não responda a desconhecidos, não deixe reconectando em laço. O código
já implementa recuo exponencial na reconexão por esse motivo.

---

## Segurança

**Só o seu número conversa com ele.** Mensagem de qualquer outro remetente é
descartada e registrada no log. Isso não é zelo excessivo: o Gideão tem acesso ao
seu computador, ao seu cofre e ao seu e-mail. Um desconhecido conseguindo
conversar com ele seria acesso remoto à sua máquina por mensagem de texto.

A comparação de número tolera o nono dígito, que o WhatsApp entrega de forma
inconsistente em celulares brasileiros — se isso não fosse tratado, a lista do
dono falharia de forma intermitente, que é a pior falha possível num controle de
acesso.

Grupos são ignorados sempre, em qualquer provedor.

O webhook confere a assinatura `X-Hub-Signature-256` sobre o **corpo cru** da
requisição. Reserializar o JSON muda os bytes e a conferência falharia sempre —
por isso o servidor guarda o corpo original antes de interpretá-lo.

**A conferência é incondicional, e `WHATSAPP_APP_SECRET` é obrigatória.** Antes,
sem o segredo configurado, a checagem era pulada e o webhook aceitava qualquer
corpo. Isso é mais grave do que parece: a URL do túnel é pública por definição —
é a Meta que precisa alcançá-la — e um POST forjado com o seu número no campo
`from` passaria pela lista do dono. Quem descobrisse o endereço teria o Gideão
inteira: o seu computador, o seu cofre, o seu e-mail.

Por isso o canal **não sobe** sem o segredo, em vez de subir com um aviso no
log. Um aviso se perde no meio do arranque; uma recusa, não.

---

## Autorização pelo celular

Se ele precisar de permissão enquanto você está na rua, a pergunta chega no
WhatsApp:

```
Preciso de autorização (risco alto)

preencher e clicar em páginas
Digitar em campos, clicar em botões e enviar formulários
neste site — inclusive fazer login.

Alvo: pje.trt8.jus.br
Motivo: consultar o processo do cliente Almeida

Responda:
1 — agora
2 — sempre neste alvo
3 — sempre, para tudo
4 — não
5 — nunca

Sem resposta em 300s, considero negado.
```

Você responde `2` e pronto. Sem isso, qualquer tarefa que dependesse de
autorização morreria esperando você voltar para o computador.

A pergunta **só vai para o celular quando não há ninguém na tela** — senão você
receberia a mesma coisa em dois lugares.

---

## Limites conhecidos

- **Foto e PDF funcionam.** Mande a foto da intimação ou o PDF da sentença e ele
  lê o conteúdo — é o caminho mais rápido para pôr um documento diante dele.
  Pelo provedor Baileys a mídia ainda não é baixada; pela Cloud API, sim.
- **Áudio não é transcrito ainda.** Ele avisa que recebeu e pede o texto.
- **Mensagem para terceiros não é enviada.** A Cloud API exige que a pessoa
  tenha escrito primeiro nas últimas 24h, ou um modelo aprovado pela Meta — os
  dois casos pedem decisão sua. Ele diz o que mandaria e você envia.
- **Respostas longas são divididas** em partes numeradas, quebrando em parágrafo
  ou frase, nunca no meio de uma palavra.
- **Uma conversa por vez.** Se você mandar outra mensagem enquanto ele ainda
  está trabalhando, ele avisa em vez de atropelar a anterior.
