# Observador de contexto

Você pediu que ela acompanhasse o que você faz, para funcionar como segundo
cérebro. Isto faz isso. É também, de longe, o módulo mais sensível do sistema, e
este documento existe para você decidir com informação e não com entusiasmo.

## O que ele captura

Duas coisas, e só duas:

- **o que você copia** (área de transferência);
- **o título da janela ativa** (em que você está trabalhando).

## O que ele **não** captura

- **Tela.** Nenhuma captura de imagem, em nenhum momento.
- **Teclas digitadas.** Isto é decisão de projeto, não limitação. Um registrador
  de teclas capturaria a sua senha no ato de digitá-la, e nenhuma filtragem
  posterior desfaz o que já foi escrito em disco.
- **Conteúdo de arquivos, e-mails ou mensagens** que você apenas abriu.

## As seis regras

**1. Nunca liga sozinho.** Não existe caminho no código em que o observador
comece a gravar sem você mandar. Nem no primeiro uso, nem depois de uma
atualização, nem "porque seria útil". Há teste garantindo que ele nasce
desligado.

**2. Fica visível enquanto grava.** Um indicador permanente no canto da tela.
Vigilância que você esquece que existe deixa de ser ferramenta e vira armadilha.

**3. Filtra antes de gravar.** Chave de API, token, chave privada, cartão e
qualquer texto com rótulo de senha nunca chegam ao disco. O filtro roda antes da
escrita.

**4. Janela sensível bloqueia o ciclo inteiro.** Com 1Password, Bitwarden,
KeePass, Nubank, Itaú, Bradesco, Caixa ou Banco do Brasil em foco, nada é
capturado — nem o título, nem a área de transferência. O que está copiado
naquele momento provavelmente veio dali.

**5. Esquece sozinho.** As capturas cruas são apagadas em **30 dias**. O que
sobrevive é o que virou memória — o objetivo é ela te entender, não manter um
dossiê.

**6. Pausa em um comando.** *"pausa o observador por 20 minutos"*. Para aquele
momento em que você vai digitar algo que não quer registrado.

## Ligar

```bash
npm run iris -- observador ligar
```

Ou na conversa: *"liga o observador"*. Vai aparecer um pedido de autorização de
**risco crítico** — o mais alto do sistema — dizendo exatamente o que vai
acontecer.

```bash
npm run iris -- observador estado
npm run iris -- observador pausar 30
npm run iris -- observador desligar
npm run iris -- observador apagar    # apaga tudo que foi capturado
```

## O que ele precisa por sistema

| Sistema | Área de transferência | Janela ativa |
|---|---|---|
| **Linux/X11** | `xclip` ou `xsel` | `xdotool` (ou `xprop`) |
| **Linux/Wayland** | `wl-clipboard` | **não é possível** |
| **macOS** | funciona de fábrica | permissão de Acessibilidade |
| **Windows** | PowerShell | PowerShell |

```bash
sudo apt install xclip xdotool       # Debian/Ubuntu com X11
sudo apt install wl-clipboard        # Wayland
```

No **Wayland**, ler o título da janela de outro aplicativo é impossível por
decisão do próprio protocolo — é uma proteção dele, não um defeito daqui. Lá só
a área de transferência funciona.

No **macOS**, a leitura do título exige liberar o terminal em *Ajustes →
Privacidade e Segurança → Acessibilidade*.

Quando falta alguma ferramenta, ela diz qual instalar em vez de ficar em
silêncio fingindo que funciona.

## O que ela faz com isso

Clipboard cru é ruído: trechos de código, URLs, pedaços de texto sem contexto.
Guardar isso não ajuda ninguém.

Toda madrugada roda a **digestão**: o material do dia é analisado em busca do que
tem valor duradouro — em que você trabalhou, que cliente apareceu, que assunto
voltou, que rotina se repete. Isso vira memória. O material cru segue o prazo de
30 dias normalmente.

A instrução dada a esse processo é explícita: registrar o **padrão**, não o dado.
Nada de conteúdo literal do que foi copiado, nada de dado pessoal de terceiros.

## Antes de ligar, pense nisto

**Você é advogado.** O que você copia inclui informação de cliente coberta por
sigilo profissional: nome, CPF, endereço, o que a pessoa te contou em confiança.
Ligar o observador é uma decisão que envolve **terceiros que não estão na
conversa** e que não consentiram.

Os filtros protegem credenciais, não segredo profissional — não há como um
programa distinguir "o cliente me contou X" de qualquer outro texto.

Mitigações reais, se você decidir ligar:

- ligue só quando estiver trabalhando em algo específico, e desligue depois;
- use `pausar` antes de abrir material sensível;
- rode `observador apagar` periodicamente;
- lembre que o backup no Drive leva as memórias derivadas junto (cifradas, mas
  levam).

E a mitigação mais honesta: **você não precisa disto para a Íris ser útil.** A
memória das conversas — que é o mecanismo principal — funciona sem o observador,
e é ela que faz o sistema conhecer você. O observador acrescenta contexto
passivo, não é o motor.

Minha recomendação: rode algumas semanas sem ele. Se em algum momento você
pensar "ela teria respondido melhor se soubesse o que eu estava fazendo às 15h",
aí ligue. Se esse momento não vier, você tem a resposta.

## Onde fica

Tudo cifrado, na tabela `observations` do banco, com a mesma chave do resto. Nada
sai da máquina, exceto o que virar memória e entrar no backup — que também sobe
cifrado.

Para ver o que existe:

```bash
npm run iris -- observador estado
```
