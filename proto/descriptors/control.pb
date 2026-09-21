
ý
!fairflow/control/v1/control.protofairflow.control.v1"}
Project
id (	Rid
name (	Rname
color (	Rcolor

owner_type (	R	ownerType
owner_id (	RownerId"V
ListProjectsByOwnerRequest

owner_type (	R	ownerType
owner_id (	RownerId"0
ListMyProjectsRequest
user_id (	RuserId"H
ListProjectsResponse0
list (2.fairflow.control.v1.ProjectRlist"Ì
CreateProjectRequest

owner_type (	R	ownerType
owner_id (	RownerId
name (	Rname
template_id (	R
templateId
modules (	Rmodules+
created_by_user_id (	RcreatedByUserId"\
CreateOrganizationRequest
name (	Rname
slug (	Rslug
user_id (	RuserId"Z
CreateOrganizationResponse
id (	Rid
name (	Rname
slug (	RslugJ"Z
Organization
id (	Rid
name (	Rname
slug (	Rslug
role (	Rrole"5
ListMyOrganizationsRequest
user_id (	RuserId"T
ListMyOrganizationsResponse5
list (2!.fairflow.control.v1.OrganizationRlist"V
Member
id (	Rid
name (	Rname
email (	Remail
role (	Rrole"3
ListMembersRequest

project_id (	R	projectId"F
ListMembersResponse/
list (2.fairflow.control.v1.MemberRlist"L
CheckAccessRequest

project_id (	R	projectId
user_id (	RuserId"C
CheckAccessResponse
allowed (Rallowed
role (	Rrole2‡
ProjectGrpcq
ListProjectsByOwner/.fairflow.control.v1.ListProjectsByOwnerRequest).fairflow.control.v1.ListProjectsResponseg
ListMyProjects*.fairflow.control.v1.ListMyProjectsRequest).fairflow.control.v1.ListProjectsResponseX
CreateProject).fairflow.control.v1.CreateProjectRequest.fairflow.control.v1.Project`
ListMembers'.fairflow.control.v1.ListMembersRequest(.fairflow.control.v1.ListMembersResponse`
CheckAccess'.fairflow.control.v1.CheckAccessRequest(.fairflow.control.v1.CheckAccessResponse2ƒ
OrganizationGrpcu
CreateOrganization..fairflow.control.v1.CreateOrganizationRequest/.fairflow.control.v1.CreateOrganizationResponsex
ListMyOrganizations/.fairflow.control.v1.ListMyOrganizationsRequest0.fairflow.control.v1.ListMyOrganizationsResponsebproto3