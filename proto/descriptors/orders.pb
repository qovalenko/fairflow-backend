
∆
fairflow/orders/v1/orders.protofairflow.orders.v1"Ç
OrderTypeField
key (	Rkey
label (	Rlabel
type (	Rtype
required (Rrequired
options (	Roptions"J
OrderTypeStage
id (	Rid
name (	Rname
order (Rorder"ú
	OrderType
id (	Rid
name (	Rname:
fields (2".fairflow.orders.v1.OrderTypeFieldRfields:
stages (2".fairflow.orders.v1.OrderTypeStageRstages%
schema_version (RschemaVersion'
webhook_enabled (RwebhookEnabled#
active_orders (RactiveOrders"ı
Order
id (	Rid
number (	Rnumber
type_id (	RtypeId
	type_name (	RtypeName

product_id (	R	productId!
product_name (	RproductName
deal_id (	RdealId
	deal_name (	RdealName

contact_id	 (	R	contactId!
contact_name
 (	RcontactName

company_id (	R	companyId!
company_name (	RcompanyName
stage_id (	RstageId

stage_name (	R	stageName
assignee_id (	R
assigneeId#
assignee_name (	RassigneeName
fields_json (	R
fieldsJson
status (	Rstatus
	dlq_error (	RdlqError

created_at (R	createdAt

updated_at (R	updatedAt"6
ListOrderTypesRequest

project_id (	R	projectId"K
ListOrderTypesResponse1
list (2.fairflow.orders.v1.OrderTypeRlist"ù
ListOrdersRequest

project_id (	R	projectId

page_index (R	pageIndex
	page_size (RpageSize
query (	Rquery
deal_id (	RdealId"Y
ListOrdersResponse-
list (2.fairflow.orders.v1.OrderRlist
total (Rtotal"7
GetOrdersKanbanRequest

project_id (	R	projectId"Ä
OrderKanbanColumn
stage_id (	RstageId

stage_name (	R	stageName1
orders (2.fairflow.orders.v1.OrderRorders"ñ
GetOrdersKanbanResponse:
stages (2".fairflow.orders.v1.OrderTypeStageRstages?
columns (2%.fairflow.orders.v1.OrderKanbanColumnRcolumns"@
GetOrderRequest

project_id (	R	projectId
id (	Rid"Ü
CreateOrderRequest

project_id (	R	projectId
deal_id (	RdealId"
order_type_id (	RorderTypeId

contact_id (	R	contactId

company_id (	R	companyId
assignee_id (	R
assigneeId
notes (	Rnotes
fields_json (	R
fieldsJson"Ö
UpdateOrderRequest

project_id (	R	projectId
id (	Rid
fields_json (	R
fieldsJson
assignee_id (	R
assigneeId"l
MoveOrderStageRequest

project_id (	R	projectId
order_id (	RorderId
stage_id (	RstageId2à

OrdersGrpcg
ListOrderTypes).fairflow.orders.v1.ListOrderTypesRequest*.fairflow.orders.v1.ListOrderTypesResponse[

ListOrders%.fairflow.orders.v1.ListOrdersRequest&.fairflow.orders.v1.ListOrdersResponsej
GetOrdersKanban*.fairflow.orders.v1.GetOrdersKanbanRequest+.fairflow.orders.v1.GetOrdersKanbanResponseJ
GetOrder#.fairflow.orders.v1.GetOrderRequest.fairflow.orders.v1.OrderP
CreateOrder&.fairflow.orders.v1.CreateOrderRequest.fairflow.orders.v1.OrderP
UpdateOrder&.fairflow.orders.v1.UpdateOrderRequest.fairflow.orders.v1.OrderX
MoveOrderToStage).fairflow.orders.v1.MoveOrderStageRequest.fairflow.orders.v1.Orderbproto3