# Permissões

## A regra

**Você autoriza uma vez. Ele não pergunta mais.**

Quando o Gideão precisa fazer algo sensível, ele pede. Você responde uma de quatro
coisas:

| Resposta | O que acontece |
|---|---|
| **Agora** | Faz desta vez. Pergunta de novo na próxima. |
| **Sempre aqui** | Grava a autorização para aquele escopo. Nunca mais pergunta ali. |
| **Sempre, para tudo** | Libera a capacidade inteira, qualquer escopo. |
| **Não** | Não faz. |
| **Nunca** | Grava a recusa. Nem chega a perguntar de novo. |

Escolhendo "sempre", vira uma linha no banco e todas as chamadas futuras que
caírem naquele escopo passam direto — sem pergunta, sem atrito, para sempre, até
você revogar.

**Silêncio nunca vira consentimento.** Pedido sem resposta em 5 minutos é negado.

## Escopo: como liberar aos poucos

A capacidade sozinha é grossa demais ("ler arquivos"). O escopo é que dá o
controle fino:

```
arquivo.ler   /home/eu/processos/**     ← todos os processos, para sempre
arquivo.ler   /home/eu/**               ← a pasta pessoal inteira
arquivo.ler   *                         ← o computador todo
```

O casamento é por glob:

- `*` vale por **um** segmento — `/processos/*` pega `/processos/a.pdf` mas não
  `/processos/2024/a.pdf`;
- `**` desce por quantos níveis houver;
- `*` sozinho vale por tudo.

Autorizar `/home/eu/processos/**` **não** libera `/etc/shadow`. É isso que
permite você começar apertado e ir abrindo conforme a confiança cresce — o
caminho que você descreveu.

## O catálogo

| Capacidade | Risco | Escopo é… |
|---|---|---|
| `sistema.info` | baixo | — |
| `web.ler` | baixo | domínio |
| `agenda.gravar` | baixo | — |
| `processo.consultar` | baixo | domínio |
| `arquivo.ler` | médio | caminho |
| `navegador.abrir` | médio | domínio |
| `navegador.baixar` | médio | domínio |
| `cofre.gravar` | médio | nome |
| `drive.gravar` | médio | — |
| `arquivo.escrever` | alto | caminho |
| `shell.executar` | alto | comando |
| `navegador.interagir` | alto | domínio |
| `email.ler` | alto | conta |
| `cofre.ler` | alto | nome |
| `whatsapp.enviar` | alto | contato |
| `arquivo.apagar` | **crítico** | caminho |
| `email.enviar` | **crítico** | destinatário |
| `observador.ligar` | **crítico** | fonte |

Capacidade fora do catálogo é tratada como **alto risco** por precaução.

### Onde o escopo do terminal é medido

O escopo de `shell.executar` é o **programa que de fato roda**, e não o primeiro
token da linha. A diferença importa:

```
sudo rm -rf /              → escopo: rm          (não "sudo")
env LANG=C pdftotext a.pdf → escopo: pdftotext   (não "env")
timeout 30 curl http://x   → escopo: curl        (não "timeout")
/usr/bin/curl http://x     → escopo: curl        (caminho e nome são o mesmo)
```

Se o escopo parasse no primeiro token, autorizar "sempre" para converter um PDF
com `env LANG=C pdftotext` gravaria a autorização no nome `env` — e
`env sh -c '…'` passaria direto, porque também começa com `env`. A promessa
desta página ("autorizar sempre para `git` não libera `rm`") só se sustenta
atravessando esses invólucros: `sudo`, `env`, `nohup`, `nice`, `timeout`,
`xargs`, `command`, `exec` e companhia.

Com `usar_shell`, o escopo é a linha inteira. Linha acima de 200 caracteres
ganha um resumo criptográfico no fim, para que dois comandos com o mesmo começo
longo não compartilhem a mesma autorização gravada.

### Navegador: o escopo é o site que está aberto

`clicar`, `preencher_campo`, `teclar`, `ler_pagina_atual` e `capturar_tela` agem
sobre a página já aberta — o endereço não está nos argumentos delas. O escopo
dessas cinco é o **domínio em que o navegador está naquele instante**.

Isso é o que impede que um "sempre aqui" dado no PJe do TRT-8 valha para o
site seguinte, qualquer que seja ele. Sem página aberta, o escopo não casa com
domínio nenhum e a autorização é pedida.

`abrir_pagina` aceita apenas `http` e `https`. `file:` daria leitura de qualquer
arquivo do disco por fora da autorização de arquivo — inclusive do chaveiro da
próprio Gideão.

## A única coisa que continua perguntando

Ações **irreversíveis** confirmam mesmo com autorização gravada:

- `rm -rf`, `mkfs`, `dd of=/dev/…`, `shred`, `fdisk`
- `git push --force`, `DROP TABLE`, `TRUNCATE`
- `curl … | bash` (baixar da internet e executar direto)
- apagar arquivo, escrever em `/etc`, `/boot`, `/usr`, `C:\Windows`
- enviar e-mail para terceiro

Isso **não é desconfiança do modelo**. É que um `rm -rf` no caminho errado não
tem desfazer, e dois segundos de confirmação são baratos perto de perder a pasta
de processos. Um `ls -la` com a mesma autorização de shell passa direto — o
atrito só aparece onde o erro é permanente.

A avaliação examina a **linha de comando inteira**, não o escopo. São coisas
diferentes de propósito: o escopo é estreito (`rm`) para que a autorização
gravada seja estreita, mas o `-rf /home/eu/processos` mora nos argumentos. Fosse
só o escopo, a confirmação avaliaria a palavra `rm` isolada — que não casa com
padrão destrutivo nenhum — e deixaria passar.

### Desligando

Se você quiser mesmo zero perguntas, é uma linha:

```bash
# em ~/.gideao/config.json
{ "permissions": { "confirmCritical": false } }
```

ou `GIDEAO_CONFIRM_CRITICAL=false` no `.env`.

Com isso, `shell.executar` liberado para `*` executa qualquer comando sem
confirmar — inclusive os que destroem dados. A decisão é sua; o sistema faz o
que você mandar. Só recomendo manter ligado: o custo é ínfimo e o benefício
aparece exatamente no dia em que você não esperava.

## Comandos

```bash
npm run gideao -- permissoes                    # lista o que está autorizado
npm run gideao -- permissoes conceder arquivo.ler '/home/eu/processos/**'
npm run gideao -- permissoes revogar cap_01H…   # revoga uma
npm run gideao -- permissoes revogar-tudo       # revoga todas
npm run gideao -- panico                        # revoga tudo + tranca as chaves
```

## Auditoria

Toda ação fica registrada: o que foi, com que autorização, se deu certo, quanto
demorou e os argumentos — **cifrados e já redigidos**, de modo que nem quem tem
a chave encontra uma senha ali.

```bash
npm run gideao -- auditoria --hoje
npm run gideao -- auditoria --acao ferramenta --limite 50
```

Um agente com acesso amplo à sua vida precisa ser auditável. Sem isso você fica
na posição de confiar sem poder verificar, que é exatamente a posição que este
projeto tenta evitar.

## Detalhe de implementação que vale conhecer

A negação tem precedência sobre a permissão. Se existirem, no mesmo escopo, uma
autorização "sempre" e uma recusa "nunca", **a recusa vence**. Na dúvida entre
permitir e negar, o sistema nega.
