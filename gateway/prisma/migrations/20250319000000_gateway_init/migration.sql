-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "gateway";

-- CreateTable
CREATE TABLE "gateway"."gateway_users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gateway_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateway"."gateway_roles" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gateway_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateway"."gateway_permissions" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gateway_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateway"."gateway_groups" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gateway_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateway"."gateway_user_roles" (
    "user_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,

    CONSTRAINT "gateway_user_roles_pkey" PRIMARY KEY ("user_id","role_id")
);

-- CreateTable
CREATE TABLE "gateway"."gateway_user_groups" (
    "user_id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,

    CONSTRAINT "gateway_user_groups_pkey" PRIMARY KEY ("user_id","group_id")
);

-- CreateTable
CREATE TABLE "gateway"."gateway_role_permissions" (
    "role_id" TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,

    CONSTRAINT "gateway_role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "gateway"."gateway_group_permissions" (
    "group_id" TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,

    CONSTRAINT "gateway_group_permissions_pkey" PRIMARY KEY ("group_id","permission_id")
);

-- CreateTable
CREATE TABLE "gateway"."gateway_entity_change_logs" (
    "id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "user_id" TEXT,
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gateway_entity_change_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gateway_users_email_key" ON "gateway"."gateway_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_users_login_key" ON "gateway"."gateway_users"("login");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_roles_code_key" ON "gateway"."gateway_roles"("code");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_permissions_code_key" ON "gateway"."gateway_permissions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_groups_code_key" ON "gateway"."gateway_groups"("code");

-- CreateIndex
CREATE INDEX "gateway_entity_change_logs_entity_type_entity_id_idx" ON "gateway"."gateway_entity_change_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "gateway_entity_change_logs_created_at_idx" ON "gateway"."gateway_entity_change_logs"("created_at");

-- AddForeignKey
ALTER TABLE "gateway"."gateway_user_roles" ADD CONSTRAINT "gateway_user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "gateway"."gateway_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway"."gateway_user_roles" ADD CONSTRAINT "gateway_user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "gateway"."gateway_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway"."gateway_user_groups" ADD CONSTRAINT "gateway_user_groups_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "gateway"."gateway_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway"."gateway_user_groups" ADD CONSTRAINT "gateway_user_groups_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "gateway"."gateway_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway"."gateway_role_permissions" ADD CONSTRAINT "gateway_role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "gateway"."gateway_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway"."gateway_role_permissions" ADD CONSTRAINT "gateway_role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "gateway"."gateway_permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway"."gateway_group_permissions" ADD CONSTRAINT "gateway_group_permissions_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "gateway"."gateway_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway"."gateway_group_permissions" ADD CONSTRAINT "gateway_group_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "gateway"."gateway_permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
