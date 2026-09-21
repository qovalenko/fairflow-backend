
ï
!fairflow/contact/v1/contact.protofairflow.contact.v1"™
Contact
id (	Rid

project_id (	R	projectId

first_name (	R	firstName
	last_name (	RlastName
phone (	Rphone
email (	Remail
middle_name (	R
middleName
position (	Rposition
company_ids	 (	R
companyIds
source
 (	Rsource
owner_id (	RownerId
tags (	Rtags
notes (	Rnotes

created_at (R	createdAt

updated_at (R	updatedAt"†
ListContactsRequest

project_id (	R	projectId

page_index (R	pageIndex
	page_size (RpageSize
query (	Rquery"^
ListContactsResponse0
list (2.fairflow.contact.v1.ContactRlist
total (Rtotal"B
GetContactRequest

project_id (	R	projectId
id (	Rid"‘
CreateContactRequest

project_id (	R	projectId

first_name (	R	firstName
	last_name (	RlastName
phone (	Rphone
email (	Remail
position (	Rposition

company_id (	R	companyId
source (	Rsource
assignee_id	 (	R
assigneeId"¡
UpdateContactRequest

project_id (	R	projectId
id (	Rid

first_name (	R	firstName
	last_name (	RlastName
phone (	Rphone
email (	Remail
position (	Rposition

company_id (	R	companyId
source	 (	Rsource
assignee_id
 (	R
assigneeId"E
DeleteContactRequest

project_id (	R	projectId
id (	Rid"F
RestoreContactRequest

project_id (	R	projectId
id (	Rid"˜
ImportContactsRequest

project_id (	R	projectId!
file_content (RfileContent
filename (	Rfilename!
mapping_json (	RmappingJson"d
ImportContactsResponse
created (Rcreated
skipped (Rskipped
errors (	Rerrors2›
ContactGrpcc
ListContacts(.fairflow.contact.v1.ListContactsRequest).fairflow.contact.v1.ListContactsResponseR

GetContact&.fairflow.contact.v1.GetContactRequest.fairflow.contact.v1.ContactX
CreateContact).fairflow.contact.v1.CreateContactRequest.fairflow.contact.v1.ContactX
UpdateContact).fairflow.contact.v1.UpdateContactRequest.fairflow.contact.v1.ContactX
DeleteContact).fairflow.contact.v1.DeleteContactRequest.fairflow.contact.v1.ContactZ
RestoreContact*.fairflow.contact.v1.RestoreContactRequest.fairflow.contact.v1.Contacti
ImportContacts*.fairflow.contact.v1.ImportContactsRequest+.fairflow.contact.v1.ImportContactsResponsebproto3