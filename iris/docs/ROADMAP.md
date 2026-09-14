# Roadmap de construção

O sistema foi construído em etapas independentes. Cada etapa é um commit próprio
e deixa o sistema funcionando — nada fica pela metade esperando a etapa seguinte.

| Etapa | Entrega | Onde está |
|---|---|---|
| 0 | Fundação: configuração em camadas, logger com redação, barramento de eventos | `src/config.ts`, `src/util/`, `src/core/events/` |
| 1 | Criptografia (envelope AES-256-GCM), banco cifrado, cofre de credenciais | `src/core/crypto/`, `src/core/db/`, `src/core/vault/` |
| 2 | Memória: episódica, semântica, procedural; embeddings; recuperação híbrida; consolidação | `src/core/memory/` |
| 3 | Permissões persistentes com escopo, níveis de risco e auditoria | `src/core/permissions/` |
| 4 | Núcleo do agente: streaming, loop de ferramentas, contexto ilimitado | `src/core/agent/` |
| 5 | Ferramentas: arquivos, shell, navegador, web, memória, cofre, agenda | `src/tools/` |
| 6 | Servidor HTTP/WebSocket + CLI de administração | `src/channels/http/`, `src/cli/` |
| 7 | Interface do orbe (tela inicial animada, voz) | `web/` |
| 8 | Canal WhatsApp | `src/channels/whatsapp/` |
| 9 | Agenda, lembretes, e-mail, monitor de processos | `src/core/scheduler/`, `src/integrations/` |
| 10 | Backup cifrado no Google Drive | `src/integrations/drive/` |
| 11 | Observador de contexto (opt-in) | `src/observer/` |
| 12 | Testes, assistente de instalação, documentação | `test/`, `src/cli/setup.ts` |

**Todas as doze concluídas.** 212 testes automatizados, 37 ferramentas, build
limpo e verificação de ponta a ponta com o sistema no ar.

## O que vem depois (ideias para evoluir)

- Reconhecimento de voz local (Whisper) em vez do motor do navegador.
- Índice vetorial persistente com `sqlite-vec` para bases acima de ~100 mil memórias.
- App móvel nativo reutilizando o mesmo WebSocket.
- Assinatura digital (certificado A1/A3) para peticionamento — exige integração
  específica por tribunal e decisão consciente sobre guarda do certificado.
