# Instalando o `claude-token-monitor`

## 1. Publicar no GitHub (uma vez)

```bash
cd D:\PROJETOS\Wilton\claude-token-monitor
git remote add origin https://github.com/wgallego0/claude-token-monitor.git
git branch -M main
git push -u origin main
# Repo já publicado em: https://github.com/wgallego0/claude-token-monitor
```

(Crie o repo vazio em github.com/new antes do `git push`.)

## 2. Instalar no Claude Code

Local (durante desenvolvimento):
```bash
claude /plugin install D:\PROJETOS\Wilton\claude-token-monitor
```

Online (qualquer máquina, depois do push):
```bash
claude /plugin install https://github.com/wgallego0/claude-token-monitor
```

## 3. Subir o servidor HTTP (para o YellowBoard ler)

Na sua máquina, em uma janela qualquer:
```bash
node D:\PROJETOS\Wilton\claude-token-monitor\scripts\usage.js --serve 9876
```

Ou inicialização automática:
- Win+R → `shell:startup`
- Cole um atalho para `D:\PROJETOS\Wilton\claude-token-monitor\scripts\start-server.bat`

Verifique:
```bash
curl http://localhost:9876/usage
```

Deve devolver JSON com `today`, `month`, `all`.

## 4. Configurar o YellowBoard

No web flasher (ou portal AP), em "URL do Monitor" cole:
```
http://<IP-da-sua-máquina>:9876/usage
```

Por exemplo `http://192.168.1.10:9876/usage`. **Não use `localhost`** — o ESP32 precisa do IP real da sua máquina na rede WiFi.

Para descobrir o IP da sua máquina:
```bash
ipconfig | findstr IPv4
```
