# Como o Gideão lembra, aprende e esquece

Guardar transcrição não é memória — é arquivo morto. O que faz o assistente
melhorar a cada dia é um ciclo de quatro tempos:

```
   CAPTURAR ──► REFLETIR ──► CONSOLIDAR ──► RECUPERAR ──┐
   (todo turno) (a cada N)   (de madrugada)  (todo turno)│
        ▲                                                │
        └────────────────────────────────────────────────┘
```

## 1. Capturar — a cada turno

Toda mensagem, sua e dele, é gravada cifrada com os blocos originais da API
(texto, chamadas de ferramenta, resultados). Isso é o alicerce do "sem limite":
mesmo quando o contexto enviado ao modelo é compactado, o diálogo inteiro
continua no banco. Compactar contexto **não apaga nada**.

## 2. Refletir — a cada 4 turnos, em segundo plano

Um segundo processo lê o trecho recente e decide o que merece virar memória.
Ele recebe também as memórias que já existem sobre aquele assunto, para poder:

- **criar** o que é novo;
- **reforçar** o que apareceu de novo (sobe confiança e importância);
- **corrigir** o que a conversa mostrou estar errado — a correção vira uma
  memória nova e a antiga fica marcada como substituída, sem ser apagada.

A instrução é explícita sobre qualidade: conversa trivial deve produzir lista
vazia. Três memórias densas valem mais que quinze frouxas.

Isso roda **fora do caminho da resposta** — você nunca espera pela reflexão.

### Os nove tipos

| Tipo | O que guarda | Exemplo |
|---|---|---|
| `fato` | verdade estável | "Advoga principalmente na comarca de Macapá." |
| `preferencia` | como você gosta | "Quer resumo começando pelo prazo mais próximo." |
| `pessoa` | cliente, colega, parte | "João Almeida, motorista, avisar por WhatsApp." |
| `processo` | caso e seu estado | "0001234-56.2024.5.08.0011, aguardando perícia." |
| `procedimento` | passo a passo aprendido | "Consulta no PJe do TRT8: login, aba Acervo, filtro…" |
| `evento` | aconteceu, tem data | "Em 12/03 decidimos recorrer." |
| `insight` | padrão que ele percebeu | "Revisa petições no fim da tarde." |
| `perfil` | seu retrato consolidado | reescrito toda madrugada |
| `credencial` | que existe credencial para X | "Há credencial `pje.senha` no cofre." |

Senha nunca vira memória. Se aparecer uma, só se registra que ela existe.

## 3. Consolidar — toda madrugada

Cinco passos, em `src/core/memory/consolidation.ts`:

1. **Envelhecer.** O que não é usado perde importância (meia-vida de 120 dias,
   estendida por uso frequente). O que fica abaixo do piso, nunca foi usado e
   passou de 180 dias é descartado. Esquecer é função da memória — sem isso o
   ruído sufoca o sinal. Memória fixada por você nunca desbota.
2. **Fundir.** Memórias quase idênticas viram uma só, ficando a mais rica e
   herdando a maior importância e a soma dos usos.
3. **Resumir.** Cada conversa encerrada ganha resumo e vira memória de `evento`
   com data — é o que permite perguntar "o que a gente decidiu na terça?".
4. **Perceber.** Procura padrões que nenhuma anotação isolada mostra. Só registra
   padrão sustentado por três ou mais anotações.
5. **Retratar.** Reescreve o seu perfil a partir das memórias mais importantes.
   Esse texto entra no prompt de toda conversa — é o que faz ele falar com
   *você* e não com um usuário genérico.

## 4. Recuperar — a cada turno

Quatro sinais somados, porque nenhum sozinho funciona:

| Sinal | Peso | Resolve |
|---|---|---|
| semântico (cosseno) | 0,45 | paráfrase, sinônimo |
| palavra-chave (índice cego) | 0,24 | nome próprio, número de processo |
| recência | 0,13 | não responder com informação vencida |
| importância | 0,13 | não afogar o relevante em trivialidade |
| uso | 0,05 | o que você consulta sempre |

Fixada pelo dono soma +0,35. Confiança baixa desconta proporcionalmente.
No fim, **MMR** evita devolver cinco versões da mesma frase ocupando o contexto.

## Embeddings: local ou Voyage

| | `local` (padrão) | `voyage` |
|---|---|---|
| Texto sai da máquina | **não** | sim |
| Custo | zero | por token |
| Funciona offline | sim | não |
| Acha paráfrase sem palavra em comum | mal (~0,2) | bem |

O provedor local usa hashing sobre palavras, trigramas de caractere e bigramas.
Ele é forte em similaridade lexical e de tema, e **fraco em paráfrase pura** —
"começar pelo prazo mais próximo" × "pelo prazo que vence antes" dá ~0,2. Nesses
casos a recuperação se apoia nos outros três sinais. Se a sua base crescer muito
e você aceitar mandar texto para fora, `GIDEAO_EMBEDDINGS=voyage` melhora
sensivelmente esse ponto.

### Sobre o limiar de duplicata

Cada provedor declara o seu (`nearDuplicate`), porque a escala de similaridade
não é comparável entre famílias de embedding. Os números não foram chutados —
estão medidos no teste de calibração (`test/memory.test.ts`): no provedor local,
quase-duplicatas caem entre 0,84 e 0,88 e conteúdo genuinamente distinto fica
abaixo de 0,25; o limiar de 0,80 mora no meio desse vão. O teste falha se essa
separação deixar de existir.

## Perguntas diretas

**Ele esquece o que eu mandei lembrar?** Não. Memória fixada (`pinned`) não
desbota e não é descartada.

**Dá para apagar algo?** Sim: `gideao memoria esquecer <id>`, ou peça na conversa.
Apagar é apagar — sai do banco.

**E se ele aprender errado?** Corrija na conversa. A correção vira memória nova
com confiança alta e a antiga é marcada como substituída — você continua podendo
auditar o que ele achava antes.

**Quanto isso custa?** A reflexão roda a cada 4 turnos com esforço médio e a
consolidação uma vez por dia. É uma fração pequena do custo da conversa em si.
