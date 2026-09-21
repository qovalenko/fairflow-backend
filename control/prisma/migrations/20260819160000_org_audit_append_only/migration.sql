-- FR-ORG-580: append-only org audit at the DB layer (normative FR-MORG-46).
-- REVOKE FROM PUBLIC is not enough: the table owner (the app role) keeps
-- UPDATE/DELETE. A BEFORE trigger rejects mutation even for the owner.
REVOKE UPDATE, DELETE ON TABLE "control"."OrgAuditLog" FROM PUBLIC;

CREATE OR REPLACE FUNCTION control.org_audit_log_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'OrgAuditLog is append-only';
END;
$$;

DROP TRIGGER IF EXISTS org_audit_log_forbid_mutation ON control."OrgAuditLog";
CREATE TRIGGER org_audit_log_forbid_mutation
  BEFORE UPDATE OR DELETE ON control."OrgAuditLog"
  FOR EACH ROW
  EXECUTE FUNCTION control.org_audit_log_append_only();
