# Os primeiros dias

Um agente com acesso à sua vida não deve começar com acesso à sua vida. Este
guia é a ordem que eu seguiria.

## Dia 1 — instalar e conversar

```bash
cd gideao
npm install
cp .env.example .env        # coloque ANTHROPIC_API_KEY
npm run setup
npm run build && npm start
```

No `setup`, quando ele perguntar a pasta de trabalho, **aponte só uma**: aquela
onde ficam os seus processos. Não aponte a raiz do disco. Você amplia depois, e
ampliar é fácil; recolher confiança depois de um susto é mais difícil.

Aí é só conversar. Nesse primeiro dia, converse sobre o seu trabalho como
conversaria com alguém novo no escritório:

> "Eu sou advogado em Macapá, trabalho principalmente com direito do trabalho.
> Meus clientes costumam ser motoristas e trabalhadores do comércio. Eu gosto de
> resposta curta primeiro e o detalhe depois, se eu pedir."

Isso não é conversa fiada: a cada 4 turnos ele extrai o que aprendeu, e é assim
que o retrato dele sobre você começa a existir.

## Dia 2 — o primeiro processo

Dê um número de processo e o nome do cliente:

> "acompanha o 0001234-56.2024.5.08.0011, é o processo do João Almeida contra a
> Transportes Norte"

Ele consulta na base pública do CNJ, guarda quem é o Almeida, e passa a avisar
quando houver movimentação. Repita para os processos que mais importam — não
precisa ser todos de uma vez.

## Dia 3 — a agenda

> "amanhã às 14h tenho audiência do Almeida na 2ª Vara do Trabalho"
> "me lembra quinta de protocolar a apelação"

Ele marca e avisa com antecedência (audiência: um dia; prazo: dois dias).
A partir daqui a agenda entra no contexto de toda conversa — ele passa a saber o
que está marcado antes de responder qualquer coisa sobre o seu dia.

## Dia 4 — a primeira credencial

Quando ele precisar entrar num sistema, vai pedir autorização. Guarde a senha
pelo terminal, **não pela conversa**:

```bash
npm run gideao -- cofre set pje.trt8.senha
```

A partir daí ele usa sozinho. Você não informa de novo, e o valor nunca aparece
no diálogo — é substituído dentro da ferramenta, no último instante.

## Semana 2 — ampliar conforme a confiança

Olhe o que ele andou fazendo:

```bash
npm run gideao -- auditoria --hoje
npm run gideao -- memoria perfil
```

O `memoria perfil` é o mais revelador: é o retrato que ele montou de você a
partir das conversas. Se estiver bom, ele entendeu. Se estiver genérico, é
porque ainda falta conversa — ou porque você não corrigiu quando ele errou.

**Corrija.** Correção é o aprendizado mais valioso que existe no sistema: vira
memória de confiança alta e substitui a anterior, sem apagar o histórico.

Aí, sim, amplie o que fizer sentido:

```bash
npm run gideao -- permissoes conceder arquivo.ler '/home/eu/**'
npm run gideao -- permissoes conceder shell.executar 'git'
```

## Semana 3 — WhatsApp

Quando a conversa na tela já estiver valendo a pena, leve para o celular
([docs/WHATSAPP.md](WHATSAPP.md)). É a mesma memória: o que você começou no
computador continua no celular.

É também quando as notificações passam a ter valor real — audiência amanhã,
movimentação nova no processo, e-mail do tribunal chegando enquanto você está
em outra audiência.

## Mês 2 — backup

Configure o Drive ([docs/DRIVE.md](DRIVE.md)) quando já houver memória que valha
a pena não perder. Antes disso, a cópia local em `~/.gideao/backups` já resolve.

## O observador: deixe para o final, ou nunca

O observador ([docs/OBSERVADOR.md](OBSERVADOR.md)) captura o que você copia e em
que janela trabalha. É a função mais chamativa e a menos necessária.

**Você não precisa dele para o Gideão ser útil.** A memória das conversas é o
motor; o observador só acrescenta contexto passivo.

Rode algumas semanas sem. Se em algum momento você pensar "ele teria respondido
melhor se soubesse o que eu estava fazendo às 15h", aí ligue. Se esse momento
não vier, você já tem a resposta.

E se você lida com informação de cliente coberta por sigilo — e lida — leia a
seção final daquele documento antes de decidir.

---

## Sinais de que está funcionando

- Ele começa a responder sem você precisar dar contexto.
- Ele lembra da preferência que você mencionou de passagem três semanas atrás.
- O aviso de audiência chega antes de você lembrar sozinho.
- Você para de explicar quem é cada cliente.

## Sinais de que algo está errado

- **Ele responde genérico.** Falta conversa, ou você não corrigiu os erros.
  Rode `memoria perfil` e veja o que ele acha que sabe.
- **Ele pergunta autorização toda hora.** Você respondeu "agora" onde devia ter
  respondido "sempre aqui". Veja com `permissoes` e conceda o que faltar.
- **Ele inventa.** Isso é um problema sério e não deve ser tolerado — traga o
  caso concreto, corrija na conversa, e veja em `auditoria` se a consulta que
  ele diz ter feito aconteceu mesmo.
