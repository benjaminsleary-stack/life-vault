---
type: topic
name: Dashboard
tags: [admin]
updated: 2026-07-14
---

# Dashboard

_Live overview, rendered by the **Dataview** plugin. Open in Reading view (or
Live Preview) to see the tables populate. Nothing here is hand-maintained — it
queries the vault every time you open it._

## Areas

[[family]] · [[house]] · [[work]] · [[health]] · [[interests]] · [[admin]] · [[index]]

## Due & overdue

```dataview
TASK
WHERE !completed AND due AND due <= date(today)
SORT due ASC
```

## Other open tasks

```dataview
TASK
WHERE !completed AND (!due OR due > date(today))
SORT due ASC
```

## Active projects

```dataview
TABLE WITHOUT ID file.link AS "Project", file.tags AS "Area", updated AS "Updated"
FROM "projects"
WHERE type = "project"
SORT updated DESC
```

## People

```dataview
TABLE WITHOUT ID file.link AS "Person", file.tags AS "Area", updated AS "Updated"
FROM "people"
WHERE type = "person"
SORT file.name ASC
```

## Upcoming occasions

_Birthdays and anniversaries pulled from each person note. Note: these are fixed
dates, so once a date passes it drops off until you bump the year._

```dataview
TABLE WITHOUT ID L.text AS "Occasion", L.occasion AS "Date"
FROM "people"
FLATTEN file.lists AS L
WHERE L.occasion AND L.occasion >= date(today)
SORT L.occasion ASC
```

## Latest digests

```dataview
TABLE WITHOUT ID file.link AS "Digest"
FROM "digests"
WHERE file.name != "Dashboard"
SORT file.name DESC
LIMIT 6
```

## Recently updated notes

```dataview
TABLE WITHOUT ID file.link AS "Note", updated AS "Updated"
FROM "notes"
SORT updated DESC
LIMIT 8
```
