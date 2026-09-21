#!/usr/bin/env bash
# Regenerate FileDescriptorSet (.pb) after proto changes. Used for tooling / backup;
# runtime reflection uses protoLoader + @grpc/reflection.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p descriptors
for f in \
  fairflow/auth/v1/auth.proto \
  fairflow/control/v1/control.proto \
  fairflow/contact/v1/contact.proto \
  fairflow/company/v1/company.proto \
  fairflow/pipe/v1/pipe.proto \
  fairflow/orders/v1/orders.proto \
  fairflow/product/v1/product.proto \
  fairflow/activity/v1/activity.proto
do
  base=$(basename "$f" .proto)
  protoc --proto_path=. --include_imports --descriptor_set_out="descriptors/${base}.pb" "$f"
  echo "descriptors/${base}.pb"
done
