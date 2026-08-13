# RMI Uploader

Microservicio para que un cliente suba actualizaciones de sus apps (Gestión RMI,
Contabilidad RMI, y a futuro Web RMI), y para que un admin las revise, las
deploye al servidor real, y pueda restaurar un backup si algo sale mal.

## Los dos perfiles

- **Usuario** — `http://<server>:8080/` (`public/index.html`). Pide la
  `UPLOAD_PASSWORD`. Sube un ZIP o archivos sueltos; quedan guardados en
  `UPLOAD_DIR` (`/tmp/rmi` por defecto), sin tocar nada del servidor todavía.
- **Admin** — `http://<server>:8080/admin.html` (`public/admin.html`). Pide la
  `ADMIN_PASSWORD`. Desde ahí se ve:
  - **Estado de contenedores**: pastillas con corriendo / detenido / no existe
    para cada app conocida.
  - **Uploads en /tmp/rmi**: lo que subió el cliente, con botón **Deploy**.
  - **Backups**: lo que `update-rmi.sh` fue guardando en cada deploy, con
    botón **Restaurar**.

## Cómo se define una "app"

Todo pasa por el objeto `APPS` en `server.js` y el `case` de `update-rmi.sh` —
**tienen que estar sincronizados a mano**, no hay una única fuente de verdad:

| app_id               | directorio real                       | contenedor                 |
|-----------------------|-----------------------------------------|------------------------------|
| `gestion_prod`         | `/srv/gestion-rmi/prod`               | `gestion-rmi`               |
| `gestion_test`         | `/srv/gestion-rmi/testing`            | `gestion-rmi-testing`       |
| `contabilidad_prod`    | `/srv/contabilidad-rmi/prod`          | `contabilidad-rmi`          |
| `contabilidad_test`    | `/srv/contabilidad-rmi/testing`       | `contabilidad-rmi-testing`  |
| `portal_web_prod`      | `/srv/rmi-web`                        | `rmi_consultores_apache`    |

Portal Web es un caso distinto a las demás: no es una app Node, es un
`httpd:alpine` sirviendo un único `index.html` bind-mounteado
(`./index.html:/usr/local/apache2/htdocs/index.html:ro`). Por eso su archivo
de validación es `index.html` (no `server.js`) — ver `VALIDATE_FILE` /
`CONTAINER_VALIDATE_PATH` en `update-rmi.sh`.

> `contabilidad_prod` migró de `/srv/contabilidad-rmi/rmi-contabilidad` a
> `/srv/contabilidad-rmi/prod` para seguir la misma convención que gestión
> (`/prod` + `/testing`). Ver la sección de migración más abajo — **esto
> requiere mover la carpeta real en el server**, no alcanza con el cambio
> de código.

Para agregar `web_rmi` (o cualquier app nueva) hay que tocar **tres lugares**:

1. `uploader/server.js` → agregar la entrada en `APPS` (`label`, `env`, `dir`,
   `container`).
2. `update-rmi.sh` (raíz del repo) → agregar el caso correspondiente
   (`APP_LABEL`, `APP_ENV`, `APP_DIR`, `CONTAINER`).
3. `docker-compose.yml` (raíz del repo) → agregar el mount del `APP_DIR` nuevo
   al servicio `rmi-uploader`, si no, `update-rmi.sh` va a intentar copiar
   archivos a una ruta que no existe dentro del contenedor.

**El nombre del contenedor tiene que ser exactamente igual** en los tres
lugares y en el `container_name:` real del `docker-compose.yml` de esa app —
si no coincide ni un carácter, ni el estado de contenedores ni el restart
automático del deploy lo van a encontrar.

## Qué tiene que tener el `docker-compose.yml` de CADA servicio

Estos `docker-compose.yml` **no viven en este repo** (son de "otro proyecto",
cada app se despliega desde su propia carpeta en `/srv`), pero el uploader
depende de que tengan el `container_name:` exacto de la tabla de arriba. Lo
único que le importa al uploader de cada uno es esa línea — el resto
(imagen, puertos, volúmenes de datos, red) es cosa de cada servicio.

**`/srv/gestion-rmi/prod/docker-compose.yml`** (producción):
```yaml
services:
  gestion-rmi:
    build: .
    container_name: gestion-rmi   # <- tiene que ser este nombre, ni uno más
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
      - ./logs:/app/logs
```

**`/srv/gestion-rmi/testing/docker-compose.yml`** (testing — mismo servicio,
otro puerto y otro nombre para no chocar con el de prod):
```yaml
services:
  gestion-rmi-testing:
    build: .
    container_name: gestion-rmi-testing
    restart: unless-stopped
    ports:
      - "3001:3000"
    volumes:
      - ./data:/app/data
      - ./logs:/app/logs
```

**`/srv/contabilidad-rmi/prod/docker-compose.yml`**:
```yaml
services:
  contabilidad-rmi:
    build: .
    container_name: contabilidad-rmi
    restart: unless-stopped
    ports:
      - "3002:3000"   # ajustar al puerto real que use esta app
```

**`/srv/contabilidad-rmi/testing/docker-compose.yml`**: ya está armado en el
server con el mismo patrón que prod (`container_name: contabilidad-rmi-testing`).

**`/srv/rmi-web/docker-compose.yml`** (Portal Web — ya existe, no es una app
Node, es Apache sirviendo un `index.html` suelto):
```yaml
services:
  web:
    image: httpd:alpine
    container_name: rmi_consultores_apache
    ports:
      - "3012:80"
    volumes:
      - ./index.html:/usr/local/apache2/htdocs/index.html:ro
    restart: always
```
Acá el deploy solo tiene sentido con un `index.html` suelto (o dentro de un
ZIP con `index.html` en la raíz) — no hay `server.js`/`package.json`/`public`/
`views` que copiar.

### Migrar Contabilidad RMI de `rmi-contabilidad` a `prod`

Este contenedor ya está en producción, así que hay que mover la carpeta sin
tirar el servicio abajo más de lo necesario:

```bash
cd /srv/contabilidad-rmi
sudo docker compose -f rmi-contabilidad/docker-compose.yml down
sudo mv rmi-contabilidad prod
cd prod
# editar docker-compose.yml: container_name ya deberia decir contabilidad-rmi (no cambia)
sudo docker compose up -d --build
```

Después de esto, `update-rmi.sh` (con el path nuevo `/srv/contabilidad-rmi/prod`)
va a encontrar todo donde corresponde. Mientras no se haga esta migración,
un deploy de `contabilidad_prod` va a copiar archivos a una carpeta `prod/`
que no existe todavía y el contenedor real (que sigue leyendo de
`rmi-contabilidad/`) no va a ver los cambios.

Si alguno de estos contenedores ya existe pero con otro nombre (por ejemplo
quedó de una migración vieja, tipo `rmi-sistema1.1`), lo más simple es
bajarlo y volver a levantarlo con el `container_name:` correcto:
```bash
docker compose down       # desde la carpeta de esa app
docker compose up -d      # ya va a quedar creado con el nombre nuevo
```
No hace falta recrear el volumen de datos ni perder nada — el nombre del
contenedor es independiente de los datos, que quedan en los volúmenes/bind
mounts de `./data`, etc.

Una vez que el nombre coincide, tanto el panel de "Estado de contenedores"
como el botón Deploy/Restaurar del admin lo van a encontrar sin tocar nada
más de este repo.

## Cómo se detecta el estado de un contenedor

`GET /mgmt/container-status` corre, **desde adentro del contenedor
`rmi-uploader`**, esto:

```
docker ps -a --format '{{.Names}}|{{.State}}'
```

y busca ahí el `container` de cada app. Esto solo funciona si:

- El socket de Docker del host está montado en `rmi-uploader`
  (`/var/run/docker.sock:/var/run/docker.sock` en `docker-compose.yml`).
- `rmi-uploader` tiene el binario `docker` instalado (`apk add docker-cli` en
  el `Dockerfile`).
- El nombre configurado en `APPS[app_id].container` coincide **exactamente**
  con el `container_name:` real del contenedor en el host (mayúsculas,
  guiones, sufijos de versión, todo).

### Si un contenedor que sabés que está corriendo aparece como "no existe"

Casi siempre es un desajuste de nombre. Para confirmarlo:

```bash
# nombres reales en el host
sudo docker ps --format '{{.Names}}'

# lo que ve el uploader desde adentro (mismo socket, mismo resultado
# si el mount está bien)
docker exec rmi-uploader docker ps --format '{{.Names}}'
```

Si las dos listas difieren, o si el segundo comando falla (`permission
denied` / `docker: not found`), el problema está en el mount del socket o en
el Dockerfile, no en `server.js`. Si las dos listas coinciden pero igual
aparece "no existe" en el panel, el nombre que espera `APPS[app_id].container`
no es el que realmente tiene el contenedor — hay que renombrarlo (recrearlo
con el `container_name:` correcto) o actualizar `APPS`/`update-rmi.sh` para
que apunten al nombre real.

## Deploy

1. Cliente sube archivos → quedan en `UPLOAD_DIR/<app_id>_<timestamp>/`.
2. Admin aprieta **Deploy** → `POST /mgmt/deploy` → corre
   `update-rmi.sh <app_id>` con `DEPLOY_SRC` apuntando a ese upload.
3. El script:
   - hace backup de `APP_DIR` actual en `BACKUPS_DIR/<app_id>_<timestamp>/`,
   - copia los archivos nuevos a `APP_DIR`,
   - hace `docker restart <container>`,
   - **valida** que el restart haya funcionado: compara el hash MD5 del
     `VALIDATE_FILE` (`server.js` para las apps Node, `index.html` para
     Portal Web) recién copiado en el host contra el que el contenedor
     tiene adentro en `CONTAINER_VALIDATE_PATH`.
4. El log se ve en vivo en el panel (SSE), incluida la linea de validacion.
   Si `docker restart` falla porque el contenedor no existe todavía, los
   archivos igual quedan copiados — solo falta levantar el contenedor a mano
   una vez. Si el restart funciona pero la validacion da **ALERTA** (los
   hashes no coinciden), significa que esa app arma su imagen con `COPY`
   en vez de bind-mount — un restart no alcanza, hace falta
   `docker compose up -d --build` en su lugar (avisar para ajustar el script
   si pasa esto).

## Restore

`POST /mgmt/restore` es el mismo flujo que deploy, pero con `DEPLOY_SRC`
apuntando a una carpeta de `BACKUPS_DIR` en vez de a un upload. Como usa el
mismo script, restaurar también genera un backup del estado actual antes de
sobreescribir — no hay forma de "perder" el estado pre-restore.

## Variables de entorno (`.env`, no versionado)

| Variable              | Uso                                                             |
|-----------------------|------------------------------------------------------------------|
| `UPLOAD_PASSWORD`     | Contraseña del perfil usuario (`/upload`).                      |
| `ADMIN_PASSWORD`      | Contraseña del panel admin (todo `/mgmt/*`).                    |
| `UPLOAD_DIR`          | Default `/tmp/rmi`.                                              |
| `BACKUPS_DIR`         | Default `/backups`.                                              |
| `RESEND_API_KEY`      | Si está vacío, se omiten los emails (se loguea nomás).           |
| `RESEND_FROM`         | Remitente de los emails.                                         |
| `DEPLOY_NOTIFY_EMAIL` | Email de admin por defecto para notificaciones de deploy/restore.|

## Seguridad — importante

El contenedor `rmi-uploader` corre **como root** y tiene el socket de Docker
del host montado a propósito, para que el panel admin pueda reiniciar otros
contenedores. Esto equivale, en la práctica, a acceso root sobre el host
entero: cualquiera que consiga la `ADMIN_PASSWORD` (o explote un bug en este
servicio) puede controlar cualquier contenedor del server. Mantené esa
contraseña fuerte y este puerto (8080) fuera de acceso público directo.
