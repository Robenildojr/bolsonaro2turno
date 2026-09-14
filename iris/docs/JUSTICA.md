# Processos, prazos e o que dá para automatizar

## O que ela faz sozinha

- **Consulta processual** pela base pública do CNJ (DataJud): classe, órgão,
  assuntos e todas as movimentações, sem CAPTCHA e sem certificado.
- **Acompanhamento**: verifica os processos marcados três vezes ao dia e avisa
  **só quando há movimentação nova**.
- **Detecção de audiência**: quando uma movimentação parece marcar audiência,
  ela cria um lembrete — sempre rotulado como *a confirmar*.
- **Navegação assistida** nos sistemas dos tribunais, com as suas credenciais
  guardadas no cofre, para o que a base pública não alcança.

```
"acompanha o 0001234-56.2024.5.08.0011, é o processo do Almeida"
"o que mudou nos meus processos essa semana?"
"entra no PJe do TRT8 e baixa a sentença do processo do Almeida"
```

## DataJud: o que tem e o que não tem

A base pública do CNJ é a fonte certa para acompanhamento. Ela é oficial,
documentada e gratuita.

| Tem | Não tem |
|---|---|
| Classe, assunto, órgão julgador | Peças e documentos |
| Todas as movimentações com data | Processo em segredo de justiça |
| Data de ajuizamento, grau | **Nome das partes** |
| Todos os tribunais do país | Tempo real (há atraso de dias) |

**A limitação que mais surpreende:** o DataJud **não indexa nome de parte**. Ele
é uma base de metadados processuais, não um buscador de pessoas. Não existe
"procura os processos do cliente João Almeida" pela base pública — isso só pelo
sistema do tribunal, autenticado, ou pelo número que você já tem.

Na prática: você dá o número uma vez, ela associa ao cliente na memória, e daí
em diante "o processo do Almeida" já resolve.

### A chave de acesso

O CNJ publica uma chave pública na [documentação da
API](https://datajud-wiki.cnj.jus.br/api-publica/). Ela já vem embutida. Se um
dia a API recusar, o CNJ rotacionou a chave: pegue a nova na wiki e ponha em
`DATAJUD_API_KEY` no `.env`. A mensagem de erro diz exatamente isso quando
acontece.

### Como o tribunal é descoberto

Do próprio número, que já carrega essa informação:

```
0001234-56.2024.5.08.0011
                ↑ ↑
                │ └── 08 = TRT da 8ª Região
                └──── 5  = Justiça do Trabalho
```

Justiça do Trabalho, Federal, Estadual, Eleitoral, Militar e os tribunais
superiores estão mapeados.

## Sistemas de tribunal: o que trava e por quê

Aqui é preciso ser direto, porque a frustração vem da expectativa errada.

| Obstáculo | Situação |
|---|---|
| **CAPTCHA** | Ela **não resolve** e não vai tentar. Ela para e te chama. |
| **Certificado digital A3/token** | Exige o dispositivo físico e PIN. Só você. |
| **Certificado A1 (arquivo)** | Tecnicamente possível, mas guardar o certificado num agente é uma decisão que só você pode tomar. Não está implementado por padrão. |
| **Login e senha** | **Funciona.** Guarde no cofre e ela usa sozinha. |
| **Sessão que expira** | O perfil do navegador é persistente: o login feito uma vez tende a durar. |
| **Site fora do ar** | Ela diz que caiu, em vez de inventar o resultado. |

O desenho é deliberado: ela automatiza o que dá para automatizar e te chama
onde trava, em vez de contornar autenticação. Um agente que burla CAPTCHA é um
agente que você não consegue auditar.

### Guardando a credencial

```bash
npm run iris -- cofre set pje.trt8.senha
```

Ela pergunta o valor no terminal (sem eco), o serviço e o usuário. Depois disso
você nunca mais informa: na próxima consulta, a Íris usa `{{cofre:pje.trt8.senha}}`
e a substituição acontece dentro do navegador, sem o valor passar pela conversa.

Foi exatamente o fluxo que você descreveu: informa uma vez, ela guarda, e daí em
diante resolve sozinha.

## Acompanhamento

```
"acompanha o 0001234-56.2024.5.08.0011, é o Almeida contra a Transportes Norte"
```

A partir daí ela verifica às 8h, 14h e 19h (configurável em
`justice.monitorCron`) e avisa na tela e no WhatsApp quando houver novidade.

Na **primeira** importação ela não dispara avisos — um processo com 200
movimentos antigos geraria 200 notificações e a ferramenta ficaria inutilizável
logo no primeiro uso.

Cada movimentação relevante também vira memória, então ela passa a conhecer o
caso: daqui a três meses, "como está o Almeida?" tem resposta sem consulta nova.

## Audiências detectadas: leia isto

Quando uma movimentação menciona audiência com data, ela cria o lembrete
automaticamente. **Esse lembrete vem marcado como "a confirmar"** e o corpo traz
o texto original de onde a data saiu.

O motivo: o DataJud não tem campo estruturado de audiência. A data é extraída por
leitura de texto, e texto de movimentação processual é irregular — data de
designação, de remarcação e de realização aparecem no mesmo formato.

**Confirme no sistema do tribunal antes de contar com ela.** Prazo processual não
é lugar para heurística, e o sistema foi escrito para dizer isso em vez de
esconder.

## Prazos

Ela cria lembrete de prazo com **dois dias de antecedência** por padrão
(audiência: um dia; compromisso comum: uma hora).

O que ela **não** faz: contar prazo processual sozinha. Contagem em dias úteis,
suspensão em recesso, prazo em dobro para a Fazenda, início pela intimação ou
pela juntada — isso depende de interpretação que varia por rito e por tribunal.
Ela marca a data que **você** disser, e lembra na hora certa.

## Configuração

```bash
# .env
DATAJUD_API_KEY=            # só se a chave pública parar de funcionar
```

```json
// ~/.iris/config.json
{
  "justice": {
    "enabled": true,
    "monitorCron": "0 8,14,19 * * *"
  }
}
```

## Comandos

```bash
npm run iris -- conversar "consulta o processo 0001234-56.2024.5.08.0011"
npm run iris -- conversar "quais processos você está acompanhando?"
```
