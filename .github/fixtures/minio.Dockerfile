# CI-only source build of the existing MinIO S3 fixture. Never push this image.
FROM docker.io/library/golang:1.24.8-bookworm@sha256:4ed690d6649d63c312b99a6120025ec79ce3b542968a37da53d6236c7c61a848 AS build
WORKDIR /src
RUN git init . \
    && git remote add origin https://github.com/minio/minio.git \
    && git fetch --depth=1 origin 9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a \
    && git checkout --detach 9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a \
    && CGO_ENABLED=0 GOTOOLCHAIN=local GOMAXPROCS=2 go build -p 2 -tags kqueue -trimpath -o /minio . \
    && mkdir -p /empty-data/tmp
FROM scratch
COPY --from=build /minio /minio
COPY --from=build /src/LICENSE /usr/share/licenses/minio/LICENSE
COPY --from=build /src/NOTICE /usr/share/licenses/minio/NOTICE
COPY --from=build --chown=1000:1000 /empty-data /data
USER 1000:1000
ENV HOME=/data TMPDIR=/data/tmp
WORKDIR /data
ENTRYPOINT ["/minio"]
