# Site Survey RF

App web (PWA) para site survey de RF com o **TinySA Basic**, pensado para celular Android. Ele lê varreduras do analisador pela USB, marca cada ponto numa planta baixa e/ou com GPS, monta um mapa de calor e exporta CSV/JSON.

## Como usar no Android

1. Abra o endereço do GitHub Pages deste repositório no **Chrome** (versão 148 ou mais nova).
2. Menu ⋮ → **Instalar app** (ou "Adicionar à tela inicial").
3. Ligue o TinySA no celular com um cabo **USB OTG** e ligue o TinySA.
4. No app: escolha **TinySA Basic (USB)** → **Conectar** → selecione o aparelho na janela do Chrome.
5. Escolha a faixa, carregue a planta (opcional), toque na planta onde você está e toque em **Coletar ponto**.
6. Ao terminar, use **Exportar CSV/JSON**.

Os pontos ficam salvos no celular mesmo se o app fechar. Depois de instalado, o app abre sem internet. O botão **Ajuda** no topo do app explica a coleta, a antena e os problemas comuns.

### TinySA Basic: entradas LOW e HIGH

O Basic tem dois conectores. O app escolhe o modo sozinho e avisa onde a antena deve estar:

- **LOW**: 0,1 a 350 MHz
- **HIGH**: 240 a 960 MHz

### Se a conexão falhar

- No Android o Web Serial não enxerga o TinySA; o modo **Automático** já usa WebUSB lá. Se precisar, escolha **Forçar WebUSB** em **Opções de conexão**.
- Use **Copiar log** e envie o conteúdo.
- Para depurar sem ocupar a USB: ative **Depuração por Wi‑Fi** nas Opções do desenvolvedor do Android e abra `chrome://inspect` no PC.

## Estrutura

```
index.html              tela
js/app.js               lógica da coleta, mapa e exportação
js/transport.js         USB: Web Serial e WebUSB (CDC-ACM), canal de comandos de texto
js/devices/index.js     lista de dispositivos
js/devices/tinysa.js    driver do TinySA Basic e simulador
js/store.js             persistência local (IndexedDB)
sw.js                   cache offline
```

### Incluir outro dispositivo

Crie `js/devices/<nome>.js` exportando um objeto com `id`, `name`, `kind`, `bands`, `defaults`, `check(params)`, `connect(ctx)`, `disconnect()` e `sweep(params, ctx)`, e acrescente-o em `js/devices/index.js`. Lembre de incluir o arquivo na lista `FILES` do `sw.js` e de trocar `VERSION`.

## Rodar no computador

```
python3 -m http.server 8000
```

Abra `http://localhost:8000` no Chrome ou no Edge. O modo **TinySA simulado** funciona sem o aparelho.
