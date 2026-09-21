
ï
!fairflow/company/v1/company.protofairflow.company.v1"©
Company
id (	Rid

project_id (	R	projectId
name (	Rname
inn (	Rinn
phone (	Rphone
email (	Remail
industry (	Rindustry
owner_id (	RownerId
tags	 (	Rtags
notes
 (	Rnotes

created_at (R	createdAt

updated_at (R	updatedAt"‡
ListCompaniesRequest

project_id (	R	projectId

page_index (R	pageIndex
	page_size (RpageSize
query (	Rquery"_
ListCompaniesResponse0
list (2.fairflow.company.v1.CompanyRlist
total (Rtotal"B
GetCompanyRequest

project_id (	R	projectId
id (	Rid"Ä
CreateCompanyRequest

project_id (	R	projectId
name (	Rname
inn (	Rinn
phone (	Rphone
email (	Remail
industry (	Rindustry
assignee_id (	R
assigneeId"Ô
UpdateCompanyRequest

project_id (	R	projectId
id (	Rid
name (	Rname
inn (	Rinn
phone (	Rphone
email (	Remail
industry (	Rindustry
assignee_id (	R
assigneeId"E
DeleteCompanyRequest

project_id (	R	projectId
id (	Rid"F
RestoreCompanyRequest

project_id (	R	projectId
id (	Rid"™
ImportCompaniesRequest

project_id (	R	projectId!
file_content (RfileContent
filename (	Rfilename!
mapping_json (	RmappingJson"e
ImportCompaniesResponse
created (Rcreated
skipped (Rskipped
errors (	Rerrors2¡
CompanyGrpcf
ListCompanies).fairflow.company.v1.ListCompaniesRequest*.fairflow.company.v1.ListCompaniesResponseR

GetCompany&.fairflow.company.v1.GetCompanyRequest.fairflow.company.v1.CompanyX
CreateCompany).fairflow.company.v1.CreateCompanyRequest.fairflow.company.v1.CompanyX
UpdateCompany).fairflow.company.v1.UpdateCompanyRequest.fairflow.company.v1.CompanyX
DeleteCompany).fairflow.company.v1.DeleteCompanyRequest.fairflow.company.v1.CompanyZ
RestoreCompany*.fairflow.company.v1.RestoreCompanyRequest.fairflow.company.v1.Companyl
ImportCompanies+.fairflow.company.v1.ImportCompaniesRequest,.fairflow.company.v1.ImportCompaniesResponsebproto3