# Segurança

## Resumo em uma frase

Tudo que é conteúdo — conversas, memórias, credenciais, auditoria — é cifrado
com AES-256-GCM sob uma chave derivada da sua senha-mestra, que nunca sai da sua
máquina; o backup sobe para o Google Drive já cifrado, e o Google não tem como
abrir.

## A cadeia de chaves

```
senha-mestra  ──scrypt(N=2^17, r=8, p=1, sal de 32 bytes)──►  KEK
                                                               │ AES-256-GCM
                                                               ▼
                                              DEK (raiz aleatória de 32 bytes)
                                                               │ HKDF-SHA256
              ┌────────────────┬───────────────┬───────────────┼──────────────┐
              ▼                ▼               ▼               ▼              ▼
        chave de dados   índice cego     chave do cofre   chave de auditoria  backup
```

- A **DEK** é sorteada uma vez e nunca aparece em claro no disco: o `keyring.json`
  guarda só a versão embrulhada pela KEK.
- Trocar a senha-mestra reembrulha a DEK. Nenhum registro do banco é reescrito e
  nenhum backup antigo deixa de abrir.
- Cada propósito tem a sua própria subchave. Se um dia uma delas vazar, ela não
  abre as outras.
- A senha-mestra **não tem recuperação**. Guarde-a num gerenciador de senhas.

## O formato selado

```
magia(4) | versão(1) | reservado(1) | IV(12) | tag(16) | texto cifrado(n)
```

IV aleatório por registro (nunca reutilizado) e tag GCM de 128 bits: adulterar um
único bit faz a leitura falhar em vez de devolver lixo silenciosamente.

O campo `aad` amarra cada bloco ao lugar onde ele mora (`messages:content:<id>`).
Copiar o blob de uma linha para outra quebra a autenticação — protege contra
troca de registros por alguém com acesso de escrita ao arquivo do banco.

## O que fica cifrado e o que não fica

| Cifrado | Em claro (o banco precisa para indexar) |
|---|---|
| Texto das mensagens | Carimbos de tempo, papel (usuário/assistente), canal |
| Conteúdo das memórias | Tipo, importância, contadores de uso |
| Valores do cofre | Nomes das credenciais (`pje.senha`) |
| Detalhes da auditoria | Nome da ação, capacidade, se deu certo |
| Lembretes, tarefas, processos | Números de processo, datas de vencimento |
| Observações do observador | Origem (área de transferência / janela) |
| Metadados das credenciais | — |

**Duas exposições conscientes, ditas sem rodeio:**

1. **Vetores de embedding ficam em claro.** Eles são necessários para o cálculo de
   similaridade. Um vetor não devolve o texto original, mas carrega o *tema* do
   que foi dito. Quem tiver o arquivo do banco consegue agrupar assuntos sem
   conseguir lê-los. Se isso incomoda, use `IRIS_EMBEDDINGS=local` (nenhum texto
   sai da máquina) e mantenha o arquivo em disco com criptografia do sistema
   operacional (LUKS, FileVault, BitLocker).
2. **Enquanto a Íris está rodando, as chaves estão na memória do processo.** É o
   que permite a ela responder. Um invasor com acesso de root à máquina *ligada e
   destrancada* alcança essas chaves. Nenhuma criptografia de aplicação resolve
   isso — a defesa é senha de tela, disco cifrado e `iris panico` quando sair.

## Busca sem descriptografar

Buscar por palavra-chave normalmente exigiria abrir todos os registros. A Íris usa
**índice cego**: cada termo vira `HMAC-SHA256(chave-de-índice, termo-normalizado)`
truncado. O banco guarda hashes; quem não tem a chave de índice não sabe que termo
cada hash representa nem consegue montar um dicionário reverso.

Normalização (minúsculas, sem acento, sem pontuação) garante que "Audiência",
"audiencia" e "AUDIÊNCIA" caiam no mesmo hash.

## O modelo de ameaças, honestamente

| Ameaça | Coberta? |
|---|---|
| Roubaram o notebook desligado | **Sim** — sem a senha-mestra o banco é ruído |
| Alguém copiou o `iris.db` do backup do sistema | **Sim** |
| Google/funcionário do Google lendo o backup | **Sim** — sobe cifrado |
| Invasor com acesso ao Drive | **Sim** — só pega bytes cifrados |
| Alguém com a máquina ligada e destrancada | **Não** — use `iris panico` e bloqueio de tela |
| Malware com root enquanto a Íris roda | **Não** — as chaves estão na RAM |
| Você entregar a senha-mestra a alguém | **Não** |
| A Anthropic ver o que é enviado no prompt | **Não** — o que vai para a API é processado lá, sob a política da Anthropic |

Este último merece uma frase: a Íris manda para a API da Anthropic o que for
necessário para responder (a pergunta, as memórias recuperadas, o resultado das
ferramentas). Se existe informação que não pode sair da sua máquina em hipótese
alguma, guarde-a no cofre — valores do cofre **nunca** são enviados ao modelo,
apenas substituídos no último instante, dentro da ferramenta.

## Credenciais: por que o modelo nunca vê a senha

O modelo trabalha com referências:

```
{{cofre:pje.senha}}
```

A substituição pelo valor real acontece dentro do executor da ferramenta, depois
de o modelo já ter terminado de escrever. Consequências práticas:

- a senha não entra na transcrição nem no histórico da conversa;
- não é enviada para a API;
- não aparece na auditoria (o log registra "usou `pje.senha`", não o valor);
- se o modelo for induzido a "repetir a senha", ele não tem o que repetir.

## Superfície de rede

- O servidor escuta em `127.0.0.1` por padrão. Não exponha na internet sem um
  túnel autenticado (Tailscale, WireGuard, Cloudflare Access).
- Todo acesso à UI e à API local exige o token de `IRIS_ACCESS_TOKEN`.
- O webhook do WhatsApp valida a assinatura `X-Hub-Signature-256` da Meta e só
  aceita mensagens do número do dono. Qualquer outro remetente é ignorado. A
  validação é incondicional e `WHATSAPP_APP_SECRET` é obrigatória: o canal não
  sobe sem ela. A URL do webhook é pública por necessidade — é a Meta que
  precisa alcançá-la — então sem assinatura conferida ela seria acesso à sua
  máquina por requisição HTTP.

## O que a revisão da etapa 14 encontrou

O sistema inteiro passou por uma revisão adversarial depois de pronto, com a
pergunta invertida: não "isto funciona?", mas "como eu abusaria disto?". Seis
falhas apareceram, todas na mesma família — o **portão de permissão concordava
com uma coisa e o código executava outra**. Ficam registradas porque quem mexer
nisto depois precisa saber o que já deu errado:

1. **A confirmação de ação irreversível avaliava só o escopo.** O escopo de
   `rm -rf /home/eu/processos` é `rm`, e `rm` sozinho não casa com padrão
   destrutivo nenhum. O comando passava sem confirmar. Agora a avaliação recebe
   a linha de comando inteira, separada do escopo de propósito.
2. **Invólucros viravam escopo.** `env`, `sudo`, `timeout`, `xargs` e afins
   eram gravados como o programa autorizado, então uma autorização dada para
   `env LANG=C pdftotext` valia para `env sh -c 'curl … | sh'`. O escopo agora
   atravessa o invólucro até o programa que de fato roda.
3. **As ferramentas de navegador pediam escopo `*`.** Responder "sempre aqui" a
   um `clicar` gravava autorização para **todos** os sites. Um
   `preencher_campo` com `{{cofre:…}}` na página seguinte digitaria a sua senha
   do PJe num formulário de outra pessoa. O escopo agora é o domínio aberto.
4. **`abrir_pagina` aceitava `file:`**, o que lia qualquer arquivo do disco sob
   uma capacidade de navegador — inclusive o chaveiro. Só `http` e `https`.
5. **`baixar_pagina` gravava em disco com autorização de leitura web.** Uma
   capacidade de risco baixo, com escopo de domínio, escrevia em `~/.bashrc` ou
   em `~/.ssh/authorized_keys`. Agora pede `arquivo.escrever` para o caminho
   alvo, além da autorização do domínio, e recusa caminho protegido.
6. **O observador passava valores por `/bin/sh`.** O nome do aplicativo em foco
   e o id da janela ativa no X11 entravam interpolados num `exec`. O id é uma
   propriedade gravável por qualquer cliente X da mesma sessão: um aplicativo
   bem nomeado executaria comando arbitrário a cada 2,5 segundos. Nada mais
   passa por shell, e o id é validado contra `0x` + hexadecimal.

Todas as seis têm teste de regressão em `test/seguranca.test.ts`, escrito para
falhar contra o código anterior à correção.

## Botão de pânico

```bash
npm run iris -- panico
```

Revoga todas as autorizações, tranca o chaveiro (apaga as chaves da memória),
derruba o observador e encerra as sessões de navegador. Depois disso, só volta a
funcionar com a senha-mestra.

## Higiene de logs

Tudo que vai para o log passa pela redação em `src/util/redact.ts`: chaves de API,
tokens OAuth, chaves privadas, campos chamados `senha`/`token`/`secret` e números
de cartão. Números de processo do CNJ são preservados de propósito — eles são
necessários para depurar e não são segredo.
