-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "auth";

-- CreateTable
CREATE TABLE "auth"."User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."Session" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "client_id" TEXT,
    "token_id" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."OAuth2Client" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_secret" TEXT,
    "name" TEXT NOT NULL,
    "redirect_uris" TEXT[],
    "grant_types" TEXT[],
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OAuth2Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."AuthorizationCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "scopes" TEXT[],
    "code_challenge" TEXT,
    "code_challenge_method" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthorizationCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."RefreshToken" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "scopes" TEXT[],
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."ApiKey" (
    "id" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "client_id" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expires_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."UserClientConsent" (
    "user_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "scopes" TEXT[],
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserClientConsent_pkey" PRIMARY KEY ("user_id","client_id")
);

-- CreateTable
CREATE TABLE "auth"."OidcProvider" (
    "id" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_secret" TEXT NOT NULL,
    "discovery_url" TEXT,
    "authorization_endpoint" TEXT,
    "token_endpoint" TEXT,
    "user_info_endpoint" TEXT,
    "jwks_uri" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY['openid', 'profile', 'email']::TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OidcProvider_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "auth"."User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_login_key" ON "auth"."User"("login");

-- CreateIndex
CREATE INDEX "Session_user_id_idx" ON "auth"."Session"("user_id");

-- CreateIndex
CREATE INDEX "Session_expires_at_idx" ON "auth"."Session"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "OAuth2Client_client_id_key" ON "auth"."OAuth2Client"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "AuthorizationCode_code_key" ON "auth"."AuthorizationCode"("code");

-- CreateIndex
CREATE INDEX "AuthorizationCode_code_idx" ON "auth"."AuthorizationCode"("code");

-- CreateIndex
CREATE INDEX "AuthorizationCode_expires_at_idx" ON "auth"."AuthorizationCode"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_token_hash_key" ON "auth"."RefreshToken"("token_hash");

-- CreateIndex
CREATE INDEX "RefreshToken_token_hash_idx" ON "auth"."RefreshToken"("token_hash");

-- CreateIndex
CREATE INDEX "RefreshToken_expires_at_idx" ON "auth"."RefreshToken"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_key_hash_key" ON "auth"."ApiKey"("key_hash");

-- CreateIndex
CREATE INDEX "ApiKey_key_hash_idx" ON "auth"."ApiKey"("key_hash");

-- CreateIndex
CREATE INDEX "ApiKey_key_prefix_idx" ON "auth"."ApiKey"("key_prefix");

-- CreateIndex
CREATE UNIQUE INDEX "OidcProvider_issuer_key" ON "auth"."OidcProvider"("issuer");

-- AddForeignKey
ALTER TABLE "auth"."Session" ADD CONSTRAINT "Session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."Session" ADD CONSTRAINT "Session_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "auth"."OAuth2Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."AuthorizationCode" ADD CONSTRAINT "AuthorizationCode_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "auth"."OAuth2Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."AuthorizationCode" ADD CONSTRAINT "AuthorizationCode_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."RefreshToken" ADD CONSTRAINT "RefreshToken_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "auth"."OAuth2Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."RefreshToken" ADD CONSTRAINT "RefreshToken_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."ApiKey" ADD CONSTRAINT "ApiKey_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "auth"."OAuth2Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."UserClientConsent" ADD CONSTRAINT "UserClientConsent_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."UserClientConsent" ADD CONSTRAINT "UserClientConsent_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "auth"."OAuth2Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
