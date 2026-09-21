
â
#fairflow/activity/v1/activity.protofairflow.activity.v1"ï
Activity
id (	Rid
type (	Rtype
title (	Rtitle 
description (	Rdescription
status (	Rstatus
priority (	Rpriority
due_date (RdueDate

start_date (R	startDate
end_date	 (RendDate
assignee_id
 (	R
assigneeId#
assignee_name (	RassigneeName
deal_id (	RdealId
	deal_name (	RdealName

contact_id (	R	contactId!
contact_name (	RcontactName

company_id (	R	companyId!
company_name (	RcompanyName
order_id (	RorderId

order_name (	R	orderName
location (	Rlocation
	direction (	R	direction
result (	Rresult
duration (Rduration
overdue (Roverdue

created_at (R	createdAt

updated_at (R	updatedAt"‚
ListActivitiesRequest

project_id (	R	projectId

page_index (R	pageIndex
	page_size (RpageSize
query (	Rquery!
overdue_only (RoverdueOnly
assignee_id (	R
assigneeId
	date_from (RdateFrom
date_to (RdateTo"b
ListActivitiesResponse2
list (2.fairflow.activity.v1.ActivityRlist
total (Rtotal">
ListActivitiesCalendarRequest

project_id (	R	projectId"Œ
CalendarEvent
id (	Rid
title (	Rtitle
start (Rstart
end (Rend
all_day (RallDay
color (	Rcolor"]
ListActivitiesCalendarResponse;
events (2#.fairflow.activity.v1.CalendarEventRevents"C
GetActivityRequest

project_id (	R	projectId
id (	Rid"ä
CreateActivityRequest

project_id (	R	projectId
type (	Rtype
title (	Rtitle 
description (	Rdescription
status (	Rstatus
priority (	Rpriority
due_date (RdueDate
assignee_id (	R
assigneeId

contact_id	 (	R	contactId

company_id
 (	R	companyId
deal_id (	RdealId
order_id (	RorderId"Ì
UpdateActivityRequest

project_id (	R	projectId
id (	Rid
title (	Rtitle
status (	Rstatus
priority (	Rpriority
due_date (RdueDate
assignee_id (	R
assigneeId2˜
ActivityGrpck
ListActivities+.fairflow.activity.v1.ListActivitiesRequest,.fairflow.activity.v1.ListActivitiesResponseƒ
ListActivitiesCalendar3.fairflow.activity.v1.ListActivitiesCalendarRequest4.fairflow.activity.v1.ListActivitiesCalendarResponseW
GetActivity(.fairflow.activity.v1.GetActivityRequest.fairflow.activity.v1.Activity]
CreateActivity+.fairflow.activity.v1.CreateActivityRequest.fairflow.activity.v1.Activity]
UpdateActivity+.fairflow.activity.v1.UpdateActivityRequest.fairflow.activity.v1.Activitybproto3