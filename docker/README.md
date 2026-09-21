# Fairflow — Docker: PostgreSQL + MongoDB

Локальный запуск двух БД для разработки.

## Запуск

```bash
cd services/docker
cp .env.example .env   # при необходимости отредактировать
docker compose up -d
```

## Подключение

**PostgreSQL** (порт 5432 по умолчанию):

- Пользователь: `fairflow` (или `POSTGRES_USER`)
- Пароль: `fairflow` (или `POSTGRES_PASSWORD`)
- БД: `fairflow` (или `POSTGRES_DB`)
- URL: `postgresql://fairflow:fairflow@localhost:5432/fairflow`

**MongoDB** (порт 27017 по умолчанию):

- Root: `root` / `fairflow` (или `MONGO_ROOT_*`)
- БД: `fairflow` (или `MONGO_DB`)
- URI: `mongodb://root:fairflow@localhost:27017/fairflow?authSource=admin`

## Остановка

```bash
docker compose down
# с удалением данных:
docker compose down -v
```
