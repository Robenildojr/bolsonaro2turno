# Backup cifrado

## O que o Google vê

Bytes aleatórios. Só isso.

O pacote é cifrado **antes** de sair da sua máquina, com uma chave derivada da
sua senha-mestra. O Google armazena o arquivo e não tem como abrir — nem ele,
nem alguém que invada a sua conta do Drive, nem alguém com uma ordem judicial
dirigida ao Google.

Isso está verificado em teste: `test/backup.test.ts` monta um backup com nome de
cliente, credencial e audiência dentro, e falha se qualquer um desses textos
aparecer nos bytes do arquivo.

## O formato

```
GIDEAOBK (6) | versão (1) | reservado (1) | sal (32) | IV (12) | tag (16) | ciphertext
                                                                          └ gzip(JSON)
```

O detalhe importante é o **sal viajar dentro do arquivo**. Isso torna o pacote
autossuficiente: a chave é `scrypt(senha-mestra, sal)` → HKDF, e nada além da
senha é necessário para abrir.

Consequência prática, que é o ponto todo de um backup: se o seu computador se
perder inteiro — disco, keyring, tudo — você instala o Gideão num computador novo
e restaura só com a senha-mestra. Não existe segunda coisa a guardar.

E a contrapartida, dita sem rodeio: **perdeu a senha-mestra, perdeu o backup.**
Não há recuperação, não há suporte que resolva, não há porta dos fundos. Guarde
a senha num gerenciador de senhas hoje.

## Duas cópias

| | Local (`~/.gideao/backups`) | Google Drive |
|---|---|---|
| Resolve | apagou algo, banco corrompeu | perdeu o computador |
| Precisa de internet | não | sim |
| Precisa de conta | não | sim |
| Quantas guarda | 14 mais recentes | 30 mais recentes |

A cópia local é feita **sempre**, e primeiro. Se o Drive falhar, o backup já
está salvo e a falha vira aviso no log, não erro.

## Configurar o Drive

### 1. Credenciais no Google Cloud

1. <https://console.cloud.google.com> → crie um projeto (ou use um existente).
2. *APIs e Serviços → Biblioteca* → ative a **Google Drive API**.
3. *Tela de permissão OAuth* → tipo **Externo** → preencha o mínimo → em
   *Usuários de teste*, adicione o seu próprio e-mail.
4. *Credenciais → Criar credenciais → ID do cliente OAuth* → tipo **App para
   computador**.
5. Copie o ID e a chave secreta.

### 2. No `.env`

```bash
DRIVE_ENABLED=true
DRIVE_CLIENT_ID=...apps.googleusercontent.com
DRIVE_CLIENT_SECRET=...
```

### 3. Autorizar

```bash
npm run gideao -- backup autorizar
```

Aparece um endereço no terminal. Abra, autorize, pronto — o refresh token vai
para o cofre cifrado.

### O escopo pedido: `drive.file`

Esse escopo dá acesso **apenas aos arquivos que o próprio Gideão criar**. Ele não
consegue ler, listar ou apagar o resto do seu Drive — seus documentos, suas
fotos, suas planilhas. Essa restrição é imposta pelo Google, não é promessa do
código.

É o escopo mínimo que serve. Se algum dia o Gideão pedir mais que isso, desconfie.

## Usar

```bash
npm run gideao -- backup agora              # gera e envia
npm run gideao -- backup agora --sem-drive  # só a cópia local
npm run gideao -- backup listar             # o que existe
npm run gideao -- backup restaurar ~/.gideao/backups/gideao-2026-09-14T18-30-45.gideao
```

Na conversa também funciona: *"faz um backup agora"*.

### Backup automático

A cada 6 horas, **se** `GIDEAO_PASSPHRASE` estiver no ambiente — a chave do pacote
vem da senha-mestra, e sem ela o Gideão não tem como gerar o arquivo sozinho.

Esse é um trade-off real e você decide qual lado prefere:

- **com `GIDEAO_PASSPHRASE` no `.env`**: backup automático funciona, e a senha
  fica em texto num arquivo do seu disco;
- **sem**: a senha só existe na sua cabeça e na memória do processo, e o backup
  passa a ser um comando manual.

Não há resposta única. Num computador pessoal com disco cifrado, a primeira
opção é razoável. Numa máquina compartilhada, a segunda.

## Restaurar

```bash
npm run gideao -- backup restaurar <arquivo>
```

Ele mostra o que o pacote contém, pede confirmação e **acrescenta**.

**Restaurar nunca apaga.** Registros com o mesmo id são ignorados; o que existe
hoje continua. O motivo: se o backup fosse de um mês atrás, sobrescrever
significaria perder tudo o que aconteceu desde então — e "restaurar um backup"
virar uma operação perigosa é o caminho mais curto para ninguém restaurar nunca.

### Recuperar em máquina nova

```bash
npm install && npm run setup      # use A MESMA senha-mestra
npm run gideao -- backup restaurar ~/Downloads/gideao-2026-09-14T18-30-45.gideao
```

Isso está coberto por teste: o pacote é aberto com um chaveiro recém-criado, sem
nenhuma relação com o original, e a credencial volta utilizável.

## O que entra no backup

Memórias (com embeddings e termos de índice), conversas e mensagens completas,
cofre de credenciais, autorizações concedidas, lembretes, tarefas, processos
acompanhados e suas movimentações, e o seu perfil consolidado.

O que **não** entra: logs, cache, perfil do navegador e a sessão do WhatsApp —
material reproduzível, que só aumentaria o arquivo.
