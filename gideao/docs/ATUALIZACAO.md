# Não ficar defasado

Três frentes. A distinção entre elas é o assunto inteiro deste documento.

| | O que entra na máquina | Roda sozinho? |
|---|---|---|
| **Conhecimento** | informação | **sim**, toda madrugada |
| **Modelo** | nada — só um aviso | **sim**, o aviso |
| **Código** | programa novo | **não** |

Informação entrando sozinha é inofensiva: no pior caso ele aprende uma bobagem
e você corrige na conversa. Programa entrando sozinho é outra história — quem
controla a origem do código controla a máquina, o cofre e o seu e-mail.

---

## 1. Conhecimento — ele estuda sozinho

Todo dia às 5h ele pesquisa na internet os temas que você acompanha e guarda o
que **mudou**.

Os temas ficam na engrenagem, em *Atualização*. Vêm com três, e você troca à
vontade:

```
mudanças no PJe e nos sistemas de tribunal do trabalho
jurisprudência recente do TST sobre temas trabalhistas
alterações na CLT e em normas processuais trabalhistas
```

Duas decisões evitam que isso vire lixo acumulado:

**A pesquisa sai pelo servidor da Anthropic**, não pela sua rede. Volta com
citação da fonte, e o seu IP não aparece numa varredura diária de sites de
tribunal.

**Só o que mudou vira memória.** A instrução é explícita em ignorar o que é
estável e o que já está na memória. Uma rodada que não encontra novidade grava
zero — e isso é acerto, não falha. Um sistema que grava alguma coisa todo dia
por obrigação enche a memória de ruído e estraga justamente a recuperação que
faz ele ser útil.

O que ele guarda entra com **confiança 0,75**, não 1,0: veio de pesquisa, não de
você. Se ele te disser algo que saiu daí e estiver errado, corrija — a correção
vira memória de confiança alta e substitui.

Por comando, quando você quiser na hora:

> "Vai pesquisar aí o que mudou no eSocial nos últimos 30 dias."

Às 5h por um motivo: depois da consolidação das 3h, para o que ele aprender já
encontrar a memória arrumada, e antes do panorama das 7h, para a novidade chegar
junto com o resto do dia.

---

## 2. Modelo — ele avisa quando sai um melhor

Modelo de linguagem envelhece rápido. Uma vez por semana ele consulta a lista
da própria Anthropic e compara com o que está usando.

Ele **avisa, não troca**. Trocar de modelo muda preço, velocidade e
comportamento de tudo — inclusive o jeito de conversar, que você acabou de
calibrar. Isso é decisão sua, feita na engrenagem ou numa frase ("passa para o
modelo novo"), não uma madrugada de terça.

A mesma checagem pega um caso mais chato: se o modelo em uso **sumiu** da lista
(foi aposentado, ou o nome está errado), ele te avisa. É a diferença entre
"existe algo melhor" e "isto vai parar de responder".

---

## 3. Código — ele confere, você decide

Uma vez por semana ele roda `git fetch` e olha se há commit novo no repositório.
Havendo, avisa com a lista do que mudou.

Aplicar é ordem sua:

> "Aplica a atualização."

Aí ele faz, nesta ordem, com rede de proteção:

1. guarda em que commit está;
2. `git pull --ff-only` (se divergiu, para — não cria merge sozinho);
3. `npm ci`;
4. `npm test` — a bateria inteira;
5. **se qualquer teste falhar, `git reset --hard` de volta** e te conta o que
   houve.

Depois é preciso reiniciar (`npm run build && npm start`) para a versão nova
entrar no ar. Ele não se reinicia sozinho.

Duas recusas por segurança:

- **Alterações locais não salvas.** Se `git status` não estiver limpo, ele não
  puxa por cima. Resolve você.
- **Capacidade crítica.** `sistema.atualizar` é de risco crítico, então confirma
  mesmo já tendo sido autorizada antes — pela mesma regra do `rm -rf`.

### Por que ele não se atualiza sozinho

Você pediu atualização automática, e esta é a parte do pedido que eu não fiz do
jeito literal. Vale dizer por quê.

A revisão de segurança da etapa 14 encontrou seis falhas neste sistema, e o tema
de todas era o mesmo: **o portão de permissão concordava com uma coisa e o
código executava outra.** Um agente que baixa e executa código novo sem
perguntar é esse buraco na forma mais pura possível — não importa quão bem
escrito esteja o resto, quem controlar a origem do código controla tudo.

O repositório é seu. A decisão de puxar de lá também é. O que dá para automatizar
sem risco — descobrir que existe, ler o que mudou, testar antes de assumir,
desfazer quando quebra — está automatizado.

O mesmo vale para "buscar ferramentas na internet": ele pesquisa, lê, aprende e
te conta. Ele não instala pacote sozinho.

---

## Desligar

Tudo na engrenagem, em *Atualização*:

- **Estudar sozinho** — desliga a pesquisa noturna
- **Avisar quando houver versão nova** — desliga a checagem de código
- **Avisar quando sair modelo melhor** — desliga a checagem de modelo

Ou por comando:

```bash
npm run gideao -- conversar "desliga o estudo automático"
```

## Por comando, a qualquer hora

| Pedido | O que acontece |
|---|---|
| "tem atualização?" | confere código e modelo, sem mudar nada |
| "aplica a atualização" | puxa, instala, testa, e desfaz se quebrar |
| "estuda aí sobre X" | pesquisa um tema avulso e guarda a novidade |
