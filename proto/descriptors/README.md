# FileDescriptorSet (.pb)

Сгенерированные дескрипторы для офлайн-инструментов. **Runtime reflection** в сервисах использует `@grpc/reflection` + `protoLoader.loadSync` по исходным `.proto`, без чтения этих файлов.

Пересборка после правок в `proto/fairflow/**`:

```bash
cd services && npm run proto:descriptors
```
