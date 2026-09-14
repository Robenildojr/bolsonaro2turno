# Permissões

## A regra

**Você autoriza uma vez. Ela não pergunta mais.**

Quando a Íris precisa fazer algo sensível, ela pede. Você responde uma de quatro
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

### Desligando

Se você quiser mesmo zero perguntas, é uma linha:

```bash
# em ~/.iris/config.json
{ "permissions": { "confirmCritical": false } }
```

ou `IRIS_CONFIRM_CRITICAL=false` no `.env`.

Com isso, `shell.executar` liberado para `*` executa qualquer comando sem
confirmar — inclusive os que destroem dados. A decisão é sua; o sistema faz o
que você mandar. Só recomendo manter ligado: o custo é ínfimo e o benefício
aparece exatamente no dia em que você não esperava.

## Comandos

```bash
npm run iris -- permissoes                    # lista o que está autorizado
npm run iris -- permissoes conceder arquivo.ler '/home/eu/processos/**'
npm run iris -- permissoes revogar cap_01H…   # revoga uma
npm run iris -- permissoes revogar-tudo       # revoga todas
npm run iris -- panico                        # revoga tudo + tranca as chaves
```

## Auditoria

Toda ação fica registrada: o que foi, com que autorização, se deu certo, quanto
demorou e os argumentos — **cifrados e já redigidos**, de modo que nem quem tem
a chave encontra uma senha ali.

```bash
npm run iris -- auditoria --hoje
npm run iris -- auditoria --acao ferramenta --limite 50
```

Um agente com acesso amplo à sua vida precisa ser auditável. Sem isso você fica
na posição de confiar sem poder verificar, que é exatamente a posição que este
projeto tenta evitar.

## Detalhe de implementação que vale conhecer

A negação tem precedência sobre a permissão. Se existirem, no mesmo escopo, uma
autorização "sempre" e uma recusa "nunca", **a recusa vence**. Na dúvida entre
permitir e negar, o sistema nega.
