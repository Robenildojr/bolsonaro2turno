# Arquitetura

```
                       ┌──────────────────────────────────────────┐
   navegador  ─ WS ──► │                                          │
   (orbe)              │            canais (channels/)            │
   WhatsApp   ─ HTTP ► │   http+ws · whatsapp · cli               │
                       └───────────────┬──────────────────────────┘
                                       │  turno do usuário
                                       ▼
                       ┌──────────────────────────────────────────┐
                       │            núcleo do agente              │
                       │  contexto ─► Claude (stream) ─► tools    │
                       └───┬────────────┬───────────────┬─────────┘
                           │            │               │
             ┌─────────────▼──┐  ┌──────▼───────┐  ┌────▼──────────┐
             │    memória     │  │  permissões  │  │  ferramentas  │
             │ episódica      │  │  capacidades │  │ fs · shell    │
             │ semântica      │  │  auditoria   │  │ navegador     │
             │ procedural     │  │  broker      │  │ web · e-mail  │
             │ perfil         │  └──────┬───────┘  │ justiça · zap │
             └───────┬────────┘         │          └────┬──────────┘
                     │                  │               │
             ┌───────▼──────────────────▼───────────────▼──────────┐
             │   armazenamento cifrado (SQLite + envelope AES)      │
             │   cofre de credenciais · trilha de auditoria         │
             └───────────────────────┬─────────────────────────────┘
                                     │  bundle cifrado
                                     ▼
                              Google Drive (zero-knowledge)
```

## Princípios

**Um barramento, muitos canais.** Web e WhatsApp são apenas transportes. Ambos
entregam um turno ao mesmo núcleo, com a mesma memória e o mesmo histórico — você
começa uma conversa na tela e continua no celular sem repetir contexto.

**Nada sensível em claro.** O conteúdo de mensagens, memórias, credenciais e da
auditoria é cifrado antes de tocar o disco. Metadados usados para indexar
(carimbo de tempo, tipo, importância) ficam em claro porque o banco precisa deles
— `docs/SEGURANCA.md` explica exatamente o que fica exposto e por quê.

**Permissão é do dono, não do modelo.** O agente nunca executa uma ação sensível
por conta própria: ele chama o broker, o broker olha as autorizações gravadas e,
se não houver, pergunta a você pelo canal ativo. A decisão "sempre" vira uma
linha no banco e a pergunta não se repete.

**Memória é um sistema, não um arquivo.** Guardar transcrição não é memória.
O que faz a Íris melhorar é o ciclo *capturar → refletir → consolidar → recuperar*
descrito em `docs/MEMORIA.md`.

## Fluxo de um turno

1. O canal recebe a mensagem e publica `agent:state = thinking`.
2. O montador de contexto junta: prompt de sistema (estável, cacheado), perfil do
   dono, memórias recuperadas para *aquela* pergunta, resumo das conversas
   anteriores relevantes e a janela quente de mensagens recentes.
3. O agente chama a Messages API em streaming. Cada token vira `agent:delta` e
   chega no orbe em tempo real.
4. Se o modelo pede uma ferramenta, o executor consulta o broker de permissões,
   roda a ferramenta, grava na auditoria e devolve o resultado ao modelo. O laço
   continua até o modelo terminar.
5. A mensagem completa é persistida cifrada. A cada N turnos dispara a reflexão
   em segundo plano, que extrai aprendizados e grava memórias novas.
6. A madrugada roda a consolidação e o backup cifrado sobe para o Drive.

## Contexto sem limite

Três mecanismos somados:

- **Compaction do servidor** (`compact_20260112`): a própria API resume o
  histórico antigo quando ele cresce demais. Os blocos de compactação voltam no
  histórico a cada requisição — é isso que mantém o fio da meada.
- **Janela quente local**: as N mensagens mais recentes sempre íntegras.
- **Memória de longo prazo**: tudo o que aconteceu continua no banco local,
  recuperável por busca semântica. Compactar o contexto **não** apaga nada.

## Mapa de diretórios

```
src/
  config.ts              configuração em camadas
  index.ts               arranque: abre o cofre, sobe canais e agendadores
  core/
    crypto/              chaveiro, cifra de envelope, blind index
    db/                  SQLite, migrações, store cifrado
    vault/               cofre de credenciais
    memory/              captura, embeddings, recuperação, consolidação, perfil
    permissions/         capacidades, broker, auditoria
    agent/               montagem de contexto, laço de ferramentas, prompts
    scheduler/           cron, lembretes, monitores
    events/              barramento tipado
  tools/                 ferramentas expostas ao modelo
  channels/              http+ws, whatsapp, cli
  integrations/          navegador, drive, e-mail, justiça
  observer/              captura de contexto (opt-in)
web/                     interface do orbe (HTML/CSS/JS sem build)
test/                    testes do núcleo
```
