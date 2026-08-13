# RMI Updater

Herramienta de deploy para las apps de RMI (Gestión RMI, Contabilidad RMI, y a
futuro Web RMI): un uploader donde el cliente sube sus actualizaciones, y un
panel admin para revisarlas, deployarlas al servidor real, y restaurar un
backup si algo sale mal.

Cada app (Gestión RMI, Contabilidad RMI, etc.) vive en su propio repo y su
propio `docker-compose.yml`, en su propia carpeta de `/srv`. Este repo **no**
contiene esas apps — solo la herramienta que las actualiza.

Ver [`uploader/README.md`](uploader/README.md) para todo el detalle: cómo
funciona, cómo agregar una app nueva, variables de entorno, y qué tiene que
tener el `docker-compose.yml` de cada servicio para que este uploader lo
detecte y lo pueda reiniciar.

## Arranque rápido

```bash
git clone <este repo>
cd rmi-updater
cp .env.example .env   # completar contraseñas y API key de Resend
docker compose up -d --build rmi-uploader
```
