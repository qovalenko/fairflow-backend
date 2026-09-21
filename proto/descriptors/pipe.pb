
è#
fairflow/pipe/v1/pipe.protofairflow.pipe.v1"_
PipelineStage
id (	Rid
name (	Rname
color (	Rcolor
order (Rorder"¥
Pipeline
id (	Rid

project_id (	R	projectId
name (	Rname7
stages (2.fairflow.pipe.v1.PipelineStageRstages

is_default (R	isDefault"F

DealSource
id (	Rid
name (	Rname
color (	Rcolor"Ë
Deal
id (	Rid
name (	Rname
amount (Ramount
currency (	Rcurrency
pipeline_id (	R
pipelineId
stage_id (	RstageId

stage_name (	R	stageName

contact_id (	R	contactId!
contact_name	 (	RcontactName

company_id
 (	R	companyId!
company_name (	RcompanyName

product_id (	R	productId!
product_name (	RproductName
source (	Rsource
assignee_id (	R
assigneeId#
assignee_name (	RassigneeName.
expected_close_date (RexpectedCloseDate
	closed_at (RclosedAt
result (	Rresult
lost_reason (	R
lostReason(
stage_entered_at (RstageEnteredAt

created_at (R	createdAt

updated_at (R	updatedAt"5
ListPipelinesRequest

project_id (	R	projectId"G
ListPipelinesResponse.
list (2.fairflow.pipe.v1.PipelineRlist"7
ListDealSourcesRequest

project_id (	R	projectId"K
ListDealSourcesResponse0
list (2.fairflow.pipe.v1.DealSourceRlist"à
ListDealsRequest

project_id (	R	projectId

page_index (R	pageIndex
	page_size (RpageSize
query (	Rquery
pipeline_id (	R
pipelineId
stage_id (	RstageId
assignee_id (	R
assigneeId"U
ListDealsResponse*
list (2.fairflow.pipe.v1.DealRlist
total (Rtotal"W
GetDealsKanbanRequest

project_id (	R	projectId
pipeline_id (	R
pipelineId"v
KanbanColumn
stage_id (	RstageId

stage_name (	R	stageName,
deals (2.fairflow.pipe.v1.DealRdeals"Š
GetDealsKanbanResponse6
pipeline (2.fairflow.pipe.v1.PipelineRpipeline8
columns (2.fairflow.pipe.v1.KanbanColumnRcolumns"?
GetDealRequest

project_id (	R	projectId
id (	Rid"­
CreateDealRequest

project_id (	R	projectId
name (	Rname
amount (Ramount
currency (	Rcurrency
pipeline_id (	R
pipelineId
stage_id (	RstageId

contact_id (	R	contactId

company_id (	R	companyId
source	 (	Rsource
assignee_id
 (	R
assigneeId"‰
UpdateDealRequest

project_id (	R	projectId
id (	Rid
name (	Rname
amount (Ramount
pipeline_id (	R
pipelineId
stage_id (	RstageId

contact_id (	R	contactId

company_id (	R	companyId
assignee_id	 (	R
assigneeId"B
DeleteDealRequest

project_id (	R	projectId
id (	Rid"i
MoveDealStageRequest

project_id (	R	projectId
deal_id (	RdealId
stage_id (	RstageId"š
DashboardStatistic
key (	Rkey
label (	Rlabel
value (Rvalue%
previous_value (RpreviousValue
growth_rate (R
growthRate"{
DealsByStagePoint
stage_id (	RstageId

stage_name (	R	stageName
count (Rcount
amount (Ramount"3
TimelinePoint
t (Rt
count (Rcount"i

TopManager
id (	Rid
name (	Rname
deals_count (R
dealsCount
amount (Ramount"4
GetDashboardRequest

project_id (	R	projectId"ë
GetDashboardResponseD

statistics (2$.fairflow.pipe.v1.DashboardStatisticR
statisticsI
deals_by_stage (2#.fairflow.pipe.v1.DealsByStagePointRdealsByStageF
deals_timeline (2.fairflow.pipe.v1.TimelinePointRdealsTimeline?
top_managers (2.fairflow.pipe.v1.TopManagerRtopManagers9
recent_deals (2.fairflow.pipe.v1.DealRrecentDeals2ç
PipeGrpc`
ListPipelines&.fairflow.pipe.v1.ListPipelinesRequest'.fairflow.pipe.v1.ListPipelinesResponsef
ListDealSources(.fairflow.pipe.v1.ListDealSourcesRequest).fairflow.pipe.v1.ListDealSourcesResponseT
	ListDeals".fairflow.pipe.v1.ListDealsRequest#.fairflow.pipe.v1.ListDealsResponsec
GetDealsKanban'.fairflow.pipe.v1.GetDealsKanbanRequest(.fairflow.pipe.v1.GetDealsKanbanResponseC
GetDeal .fairflow.pipe.v1.GetDealRequest.fairflow.pipe.v1.DealI

CreateDeal#.fairflow.pipe.v1.CreateDealRequest.fairflow.pipe.v1.DealI

UpdateDeal#.fairflow.pipe.v1.UpdateDealRequest.fairflow.pipe.v1.DealI

DeleteDeal#.fairflow.pipe.v1.DeleteDealRequest.fairflow.pipe.v1.DealQ
MoveDealToStage&.fairflow.pipe.v1.MoveDealStageRequest.fairflow.pipe.v1.Deal]
GetDashboard%.fairflow.pipe.v1.GetDashboardRequest&.fairflow.pipe.v1.GetDashboardResponsebproto3