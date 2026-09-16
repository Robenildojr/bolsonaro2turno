# Ajustes

Três caminhos para mudar qualquer coisa nele, e **uma lista só** por trás dos
três.

| Caminho | Como | Serve para |
|---|---|---|
| **Engrenagem** | ícone no canto superior esquerdo da tela | mexer com calma, ver tudo de uma vez |
| **Conversa** | "fala mais devagar", "me chama de doutor" | o ajuste que te ocorre no meio do trabalho |
| **Linha de comando** | `npm run gideao -- ...` | script, atalho, quando a tela não está aberta |

## A engrenagem

Fica no canto superior esquerdo, com 22% de opacidade — quase invisível até
você procurar. Isso é deliberado: a tela inicial é o orbe, e nada deve competir
com ele. Passe o mouse (ou dê Tab) e ela acende.

O painel entra pela esquerda, agrupado:

- **Identidade** — o nome dele, o seu, o fuso horário
- **Voz** — qual voz, velocidade, tom, e se ele lê as respostas em voz alta
- **Tela** — legenda embaixo do orbe, cor do orbe
- **Raciocínio** — quanto esforço ele gasta pensando
- **Atualização** — se estuda sozinho, que temas acompanha, se avisa de versão nova
- **Segurança** — confirmação de ação irreversível, prazo de autorização, observador
- **Autorizações** — tudo que você já liberou, com um "revogar" em cada

Não há botão "salvar". Interruptor e lista gravam na hora; texto e números
gravam meio segundo depois da última tecla, e aparece "salvo" embaixo. Botão de
aplicar num painel deste tamanho é atrito sem função — e, pior, deixa você sem
saber se o que mexeu valeu.

### A voz

A lista de vozes **não vem do servidor**: depende do navegador e do sistema onde
você abriu a página. O botão *ouvir* fala uma frase de amostra com os ajustes
atuais, antes de você decidir.

Vazio significa escolha automática, que procura uma voz masculina em português.
Isso importa porque o padrão do navegador em pt-BR costuma ser feminino — a
"Google português do Brasil" no Chrome e a "Luciana" no macOS são os dois casos
mais comuns. A Web Speech API não tem campo de gênero, então o reconhecimento é
por nome (Felipe no macOS, Daniel no Windows, e por aí). Nome desconhecido não
vira masculino por otimismo: fica de fora, e você escolhe na lista.

Se aparecer *"nenhuma voz em português instalada"*, o sistema não tem voz pt-BR.
No Windows isso se resolve em Configurações → Hora e idioma → Idioma → Português
(Brasil) → Opções → Voz.

## Pela conversa

> "Gideão, fala mais devagar."
> "Me chama de doutor Robenildo."
> "Deixa o orbe mais azul."
> "Passa a acompanhar também mudanças no eSocial."

Ele usa `ver_ajustes` para descobrir a chave certa e `mudar_ajuste` para gravar.
A capacidade é `config.alterar`, de risco médio — pede autorização na primeira
vez e nunca mais.

## Pela linha de comando

```bash
npm run gideao -- status                 # inclui o endereço e o token
npm run gideao -- permissoes             # o que está autorizado
npm run gideao -- permissoes revogar-tudo
```

---

## O que **não** é ajustável, e por quê

Esta é a parte que importa mais que a lista do que é.

A configuração guarda o token de acesso da interface, o segredo do app do
WhatsApp e as credenciais do Drive. Se o caminho fosse "escreva qualquer chave
em `config.json`", bastaria convencer o modelo a "ajustar uma configuração" para
ele reescrever `server.accessToken` — e quem soubesse o valor novo entraria na
sua interface.

Por isso existe uma **lista fechada**, em `src/core/settings/ajustes.ts`. O que
não está nela não é alterável por nenhum dos três caminhos. Com ela, o pior que
um pedido mal-intencionado consegue é mudar a cor do orbe.

Ficam de fora, de propósito:

- qualquer chave, token ou segredo;
- o número do dono no WhatsApp — é o **controle de acesso** daquele canal;
- o diretório de dados;
- ligar o observador.

### Os ajustes que só a tela alcança

Três ajustes existem na lista mas recusam vir da conversa:

| Ajuste | Por quê |
|---|---|
| `permissions.confirmCritical` | é o freio das ações irreversíveis |
| `permissions.requestTimeoutSec` | é o prazo em que o silêncio vira "não" |
| `observer.enabled` | é vigilância; ligar exige consentimento explícito |

O raciocínio é um só: **o que protege você do sistema não se afrouxa por uma
frase dita de passagem.** Esses três você mexe na tela, olhando, ou pela linha
de comando — nos dois casos é você mesmo, e não um pedido interpretado no meio
de uma conversa.

O observador tem ainda uma trava a mais: pela engrenagem só dá para **desligar**.
Desligar vigilância é sempre seguro; ligar passa pelo caminho descrito em
[OBSERVADOR.md](OBSERVADOR.md).

## Acrescentar um ajuste novo

Uma entrada em `AJUSTES`, em `src/core/settings/ajustes.ts`. Ela aparece sozinha
na engrenagem, na conversa e na CLI — não há tela para editar nem rota para
escrever.
