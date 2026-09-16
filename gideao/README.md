# Gideão — agente pessoal de IA

Um assistente que conversa com você por voz ou texto numa tela minimalista (só um
orbe animado), atende também no WhatsApp, **lembra de tudo** que vocês conversam,
aprende com o uso, cuida da sua agenda, acompanha processos judiciais e opera o
computador e o navegador **com a sua autorização** — autorização que ele pede uma
vez e nunca mais.

Toda a memória é criptografada com uma senha que só você tem. O backup no Google
Drive sobe **já criptografado**: o Google guarda os bytes, mas não consegue ler.

---

## Em 5 minutos

```bash
cd gideao
npm install
cp .env.example .env         # coloque ao menos ANTHROPIC_API_KEY
npm run setup                # cria a senha-mestra, o cofre e o banco
npm run build && npm start
```

Abra <http://127.0.0.1:4319>. A tela é preta com um orbe no centro:

- **parado** — respirando devagar, esperando você;
- **ouvindo** — o anel vira um equalizador que reage à sua voz;
- **pensando** — o círculo perde a borda e pontos orbitam no meio;
- **respondendo** — os pontos pulsam no ritmo do texto que ele escreve.

Fale (botão do microfone ou barra de espaço) ou digite. Não há limite de
tamanho nem de quantidade de perguntas: quando a conversa fica longa, o histórico
antigo é compactado pelo servidor da Anthropic e, em paralelo, guardado inteiro e
criptografado no seu banco local — nada é perdido.

---

## O que ele faz

### Conversa e memória
- Diálogo por texto e voz, sem limite de turnos.
- Cada conversa vira memória: fatos sobre você, preferências, pessoas, clientes,
  processos, procedimentos ("como eu gosto que tal coisa seja feita").
- A cada poucos turnos ele roda uma **reflexão** em segundo plano e extrai o que
  aprendeu. Toda madrugada roda uma **consolidação**: agrupa, resume, promove o
  que é importante, esquece o que envelheceu e reescreve o seu perfil.
- Recuperação híbrida (semântica + palavra-chave + recência + importância):
  ele traz para o contexto só o que interessa àquele momento.

### Autorizações que se lembram
- Toda ação sensível passa por um **broker de permissões**: ele pede, você decide.
- As opções são *permitir agora*, *permitir sempre neste escopo*, *permitir sempre
  nesta categoria* ou *negar*. Escolhendo "sempre", **ele nunca mais pergunta**.
- Tudo o que ele faz fica numa trilha de auditoria criptografada que você pode ler:
  `npm run gideao -- auditoria`.
- Ações destrutivas (apagar em massa, formatar, mandar mensagem para terceiros)
  continuam confirmando mesmo autorizadas — você pode desligar isso em
  `docs/PERMISSOES.md`, mas leia antes o porquê.

### Documentos e imagens
Arraste uma foto ou um PDF para a tela, cole da área de transferência, ou mande
pelo WhatsApp: ele **enxerga**. Petição digitalizada, print de sistema, foto de
intimação. Documento que já está no seu computador ele abre sozinho —
*"lê a petição em ~/processos/almeida.pdf"*.

O anexo fica cifrado no disco e o histórico guarda só uma referência leve: você
pergunta cinco coisas sobre a foto e a conversa continua barata.

### Ferramentas
São **43**, todas passando pelo broker de permissões: arquivos, terminal,
navegador real (Playwright, com login que persiste), busca e leitura na web,
cofre de credenciais, memória, agenda e lembretes, e-mail (IMAP/SMTP), consulta
processual no CNJ, leitura de documentos e imagens, WhatsApp, backup cifrado, o
observador de contexto, os próprios ajustes e a atualização contínua.

### Ajustes e evolução
A engrenagem no canto superior esquerdo abre tudo que dá para configurar: nome,
voz (masculina, com lista e botão de ouvir), cor do orbe, esforço de raciocínio,
o que ele acompanha e as autorizações já dadas. O mesmo se faz falando — *"fala
mais devagar"*, *"me chama de doutor"* — e a mesma lista vale para os dois
caminhos. Nenhum deles alcança chave, token ou senha: veja
[docs/AJUSTES.md](docs/AJUSTES.md).

Toda madrugada ele pesquisa os temas que você acompanha e guarda o que mudou.
Uma vez por semana confere se saiu versão nova do código ou modelo mais novo, e
avisa. Aplicar código é sempre decisão sua, e ele roda os testes antes de assumir
— [docs/ATUALIZACAO.md](docs/ATUALIZACAO.md).

Ele também **não nasce do zero**: a instalação oferece importar a memória de
nascimento, com quem é você, como você quer ser tratado e por que cada peça do
sistema é como é.

### Vida prática
- Lembretes de audiência, compromisso e prazo, com aviso na tela e no WhatsApp.
- Monitor de processos (DataJud/CNJ + consulta assistida por navegador): avisa
  quando há movimentação nova e cria lembrete quando encontra data de audiência.
- Monitor de e-mail com regras ("me avise se chegar algo do TRT").
- Rotina do dia: ele te dá o panorama da manhã e fecha o dia com o que ficou.

### Segurança
- Chave derivada da sua senha-mestra (scrypt, N=2^17) envolvendo uma chave de
  dados (AES-256-GCM). Trocar a senha não exige recriptografar tudo.
- Conteúdo de mensagens, memórias, credenciais e auditoria: cifrados em repouso.
- Busca por palavra-chave sem descriptografar, via *blind index* (HMAC-SHA-256).
- Backup no Drive cifrado de ponta a ponta, restaurável só com a sua senha.
- Servidor escuta apenas em `127.0.0.1` e exige token de acesso.

---

## Comandos

```bash
npm run setup                           # assistente de instalação
npm start                               # sobe o servidor e os canais
npm run gideao -- status                  # estado geral
npm run gideao -- conversar "..."         # uma pergunta pelo terminal

npm run gideao -- memoria listar          # o que ele lembra
npm run gideao -- memoria buscar "INSS"   # busca na memória
npm run gideao -- memoria perfil          # o retrato que ele fez de você
npm run gideao -- memoria consolidar      # roda a rotina noturna agora

npm run gideao -- permissoes              # o que está autorizado
npm run gideao -- permissoes conceder arquivo.ler '/home/eu/processos/**'
npm run gideao -- permissoes revogar-tudo

npm run gideao -- cofre set pje.senha     # guarda credencial (pede no terminal)
npm run gideao -- cofre listar            # nomes, nunca valores

npm run gideao -- auditoria --hoje        # o que ele fez hoje
npm run gideao -- backup agora            # backup cifrado
npm run gideao -- backup restaurar <arq>  # restaura
npm run gideao -- observador estado       # captura de contexto (opt-in)
npm run gideao -- senha                   # troca a senha-mestra
npm run gideao -- panico                  # revoga tudo e tranca as chaves
```

---

## Documentação

| Arquivo | Assunto |
|---|---|
| [docs/ARQUITETURA.md](docs/ARQUITETURA.md) | Como as peças se encaixam |
| [docs/SEGURANCA.md](docs/SEGURANCA.md) | Modelo de ameaças, criptografia, o que é e o que não é protegido |
| [docs/PERMISSOES.md](docs/PERMISSOES.md) | Capacidades, escopos, níveis de risco |
| [docs/MEMORIA.md](docs/MEMORIA.md) | Como ele aprende e esquece |
| [docs/WHATSAPP.md](docs/WHATSAPP.md) | Configurar o canal (oficial e alternativo) |
| [docs/DRIVE.md](docs/DRIVE.md) | Backup cifrado |
| [docs/JUSTICA.md](docs/JUSTICA.md) | Consulta e monitoramento processual |
| [docs/AJUSTES.md](docs/AJUSTES.md) | A engrenagem, o que muda por conversa e o que não muda |
| [docs/ATUALIZACAO.md](docs/ATUALIZACAO.md) | Como ele se mantém em dia, e o que não faz sozinho |
| [docs/OBSERVADOR.md](docs/OBSERVADOR.md) | Captura de contexto e seus limites |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Etapas da construção |
| [docs/PRIMEIROS-DIAS.md](docs/PRIMEIROS-DIAS.md) | O que fazer na primeira semana |

---

## O estado do projeto

275 testes automatizados cobrindo criptografia, memória, permissões, executor de
ferramentas, agenda, WhatsApp, anexos, backup, observador e ajustes — inclusive os casos que
importam de verdade: que a senha nunca chega ao modelo, que a autorização não
vaza de escopo, que o backup é ilegível sem a senha-mestra e que o observador
nasce desligado.

```bash
npm test        # 275 testes
npm run build   # compila
```

## Três avisos honestos

1. **Ele roda no seu computador, com as suas credenciais.** Isso é o que o torna
   útil e também o que exige cuidado: qualquer pessoa com acesso à sua máquina
   desbloqueada tem acesso ao Gideão. Use senha de tela e senha-mestra forte.
2. **A senha-mestra não tem recuperação.** É esse o preço de o Google não
   conseguir ler seu backup. Guarde-a num gerenciador de senhas.
3. **Sites de tribunal têm CAPTCHA, certificado digital e termos de uso.** O Gideão
   automatiza o que dá para automatizar e te chama quando trava — ele não quebra
   CAPTCHA e não contorna autenticação. Veja `docs/JUSTICA.md`.
