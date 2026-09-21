-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "control";

-- CreateTable
CREATE TABLE "control"."system_settings" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "inn" TEXT,
    "kpp" TEXT,
    "ogrn" TEXT,
    "legal_address" TEXT,
    "actual_address" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "logo_url" TEXT,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control"."Project" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "template_id" TEXT,
    "modules" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "module_configs" JSONB,
    "module_policies" JSONB,
    "visibility_config" JSONB,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'active',
    "deletion_scheduled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control"."ProjectMember" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "department_id" TEXT,
    "binding_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control"."DepartmentProjectBinding" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "default_role" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'self',
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepartmentProjectBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control"."ProjectAccessEpoch" (
    "project_id" TEXT NOT NULL,
    "epoch" BIGINT NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectAccessEpoch_pkey" PRIMARY KEY ("project_id")
);

-- CreateTable
CREATE TABLE "control"."Department" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parent_id" TEXT,
    "leader_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control"."AccessUnit" (
    "id" TEXT NOT NULL,
    "scope_type" TEXT NOT NULL,
    "scope_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "parent_id" TEXT,
    "leader_user_id" TEXT,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccessUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control"."AccessUnitMember" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "member_type" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "added_by" TEXT,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccessUnitMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control"."RecordShare" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "record_id" TEXT NOT NULL,
    "grantee_type" TEXT NOT NULL,
    "grantee_id" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "RecordShare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control"."Employee" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "department_id" TEXT,
    "role" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control"."Invitation" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "department_id" TEXT,
    "token" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "project_grants" JSONB,
    "invited_by_user_id" TEXT NOT NULL,
    "accepted_user_id" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control"."Role" (
    "id" TEXT NOT NULL,
    "scope_type" TEXT NOT NULL,
    "scope_id" TEXT,
    "key" TEXT,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'custom',
    "default_visibility" TEXT,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control"."RolePermission" (
    "id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "condition" JSONB,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control"."RoleAssignment" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL DEFAULT 'user',
    "subject_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'project',
    "expires_at" TIMESTAMP(3),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoleAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control"."PermissionGrant" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "module_id" TEXT NOT NULL,
    "effect" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL DEFAULT '*',
    "grantee_type" TEXT,
    "grantee_id" TEXT,
    "condition" JSONB,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PermissionGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control"."RoleAuditLog" (
    "id" TEXT NOT NULL,
    "project_id" TEXT,
    "org_id" TEXT,
    "actor_user_id" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "summary" TEXT,
    "before" JSONB,
    "after" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "chain_hash" TEXT,
    "prev_hash" TEXT,

    CONSTRAINT "RoleAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control"."OrgAuditLog" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "chain_hash" TEXT,
    "prev_hash" TEXT,

    CONSTRAINT "OrgAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control"."ControlOutbox" (
    "message_id" TEXT NOT NULL,
    "routing_key" TEXT NOT NULL,
    "project_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "envelope" JSONB NOT NULL,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "ControlOutbox_pkey" PRIMARY KEY ("message_id")
);

-- CreateTable
CREATE TABLE "control"."ProjectIntegration" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "secret" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control"."WebhookDelivery" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "integration_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "http_code" INTEGER,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control"."ProjectApiKey" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "ProjectApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "system_settings_slug_key" ON "control"."system_settings"("slug");

-- CreateIndex
CREATE INDEX "Project_owner_id_idx" ON "control"."Project"("owner_id");

-- CreateIndex
CREATE INDEX "ProjectMember_user_id_idx" ON "control"."ProjectMember"("user_id");

-- CreateIndex
CREATE INDEX "ProjectMember_binding_id_idx" ON "control"."ProjectMember"("binding_id");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectMember_project_id_user_id_key" ON "control"."ProjectMember"("project_id", "user_id");

-- CreateIndex
CREATE INDEX "DepartmentProjectBinding_organization_id_idx" ON "control"."DepartmentProjectBinding"("organization_id");

-- CreateIndex
CREATE INDEX "DepartmentProjectBinding_project_id_idx" ON "control"."DepartmentProjectBinding"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "DepartmentProjectBinding_department_id_project_id_key" ON "control"."DepartmentProjectBinding"("department_id", "project_id");

-- CreateIndex
CREATE INDEX "Department_organization_id_idx" ON "control"."Department"("organization_id");

-- CreateIndex
CREATE INDEX "AccessUnit_scope_type_scope_id_idx" ON "control"."AccessUnit"("scope_type", "scope_id");

-- CreateIndex
CREATE INDEX "AccessUnit_scope_id_kind_idx" ON "control"."AccessUnit"("scope_id", "kind");

-- CreateIndex
CREATE INDEX "AccessUnit_parent_id_idx" ON "control"."AccessUnit"("parent_id");

-- CreateIndex
CREATE INDEX "AccessUnitMember_member_type_member_id_idx" ON "control"."AccessUnitMember"("member_type", "member_id");

-- CreateIndex
CREATE INDEX "AccessUnitMember_unit_id_idx" ON "control"."AccessUnitMember"("unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "AccessUnitMember_unit_id_member_type_member_id_key" ON "control"."AccessUnitMember"("unit_id", "member_type", "member_id");

-- CreateIndex
CREATE INDEX "RecordShare_project_id_resource_grantee_type_grantee_id_idx" ON "control"."RecordShare"("project_id", "resource", "grantee_type", "grantee_id");

-- CreateIndex
CREATE INDEX "RecordShare_project_id_resource_record_id_idx" ON "control"."RecordShare"("project_id", "resource", "record_id");

-- CreateIndex
CREATE UNIQUE INDEX "RecordShare_project_id_resource_record_id_grantee_type_gran_key" ON "control"."RecordShare"("project_id", "resource", "record_id", "grantee_type", "grantee_id");

-- CreateIndex
CREATE INDEX "Employee_organization_id_is_active_idx" ON "control"."Employee"("organization_id", "is_active");

-- CreateIndex
CREATE INDEX "Employee_user_id_idx" ON "control"."Employee"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_organization_id_user_id_key" ON "control"."Employee"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_token_key" ON "control"."Invitation"("token");

-- CreateIndex
CREATE INDEX "Invitation_organization_id_idx" ON "control"."Invitation"("organization_id");

-- CreateIndex
CREATE INDEX "Invitation_email_idx" ON "control"."Invitation"("email");

-- CreateIndex
CREATE INDEX "Role_scope_type_scope_id_idx" ON "control"."Role"("scope_type", "scope_id");

-- CreateIndex
CREATE UNIQUE INDEX "Role_scope_type_scope_id_key_key" ON "control"."Role"("scope_type", "scope_id", "key");

-- CreateIndex
CREATE INDEX "RolePermission_role_id_idx" ON "control"."RolePermission"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "RolePermission_role_id_subject_action_key" ON "control"."RolePermission"("role_id", "subject", "action");

-- CreateIndex
CREATE INDEX "RoleAssignment_project_id_subject_type_subject_id_idx" ON "control"."RoleAssignment"("project_id", "subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "RoleAssignment_role_id_idx" ON "control"."RoleAssignment"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "RoleAssignment_project_id_subject_type_subject_id_role_id_s_key" ON "control"."RoleAssignment"("project_id", "subject_type", "subject_id", "role_id", "scope");

-- CreateIndex
CREATE INDEX "PermissionGrant_project_id_module_id_idx" ON "control"."PermissionGrant"("project_id", "module_id");

-- CreateIndex
CREATE INDEX "PermissionGrant_project_id_subject_action_idx" ON "control"."PermissionGrant"("project_id", "subject", "action");

-- CreateIndex
CREATE INDEX "RoleAuditLog_project_id_created_at_idx" ON "control"."RoleAuditLog"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "RoleAuditLog_org_id_created_at_idx" ON "control"."RoleAuditLog"("org_id", "created_at");

-- CreateIndex
CREATE INDEX "OrgAuditLog_organization_id_created_at_idx" ON "control"."OrgAuditLog"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "ControlOutbox_status_created_at_idx" ON "control"."ControlOutbox"("status", "created_at");

-- CreateIndex
CREATE INDEX "ProjectIntegration_project_id_created_at_idx" ON "control"."ProjectIntegration"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "WebhookDelivery_project_id_integration_id_created_at_idx" ON "control"."WebhookDelivery"("project_id", "integration_id", "created_at");

-- CreateIndex
CREATE INDEX "ProjectApiKey_project_id_created_at_idx" ON "control"."ProjectApiKey"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "ProjectApiKey_key_hash_idx" ON "control"."ProjectApiKey"("key_hash");

-- AddForeignKey
ALTER TABLE "control"."ProjectMember" ADD CONSTRAINT "ProjectMember_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "control"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "control"."Department" ADD CONSTRAINT "Department_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "control"."Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "control"."AccessUnit" ADD CONSTRAINT "AccessUnit_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "control"."AccessUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "control"."AccessUnitMember" ADD CONSTRAINT "AccessUnitMember_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "control"."AccessUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "control"."Employee" ADD CONSTRAINT "Employee_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "control"."Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "control"."RolePermission" ADD CONSTRAINT "RolePermission_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "control"."Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "control"."RoleAssignment" ADD CONSTRAINT "RoleAssignment_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "control"."Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

