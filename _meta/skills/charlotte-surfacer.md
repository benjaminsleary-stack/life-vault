# Skill: charlotte-surfacer

Pick the **one** thing about [[Charlotte]] worth having in Ben's head today, and
hand it to the morning brief. One item or none. Read `CLAUDE.md`.

## Why this is the most important skill here

Ben, 1 August 2026, asked what actually works with Charlotte:

> *"Paying her more attention and remembering what's on her mind and talking
> about it. **My biggest problem is I can't track these things.**"*

And what she has said she needs, from the 19 July interview:

> *"To feel known and understood."*

So the job is not encouragement and it is not advice. It is **recall**: putting a
specific thing she said, on a specific day, back in front of him at the moment it
is useful. That is a memory problem, which is the one problem a vault is actually
good at. Everything else here is secondary to this.

## What to surface, in priority order

1. **An open loop** — something she said was coming up or worrying her, whose date
   is now near or just past. "Her mum's operation is on the 14th" surfaced on the
   13th is the entire point. These outrank everything below.
2. **Something she raised that he hasn't followed up** — a fragment with no later
   fragment answering it.
3. **A near occasion** — birthday, anniversary — far enough ahead to act on
   (7–21 days). Not on the day; on the day it is too late to do anything.
4. **A durable fact worth re-reading**, only if it suggests something concrete
   today.

## What NOT to surface

- Anything under `## Private`. Never. Not summarised, not alluded to, not used as
  the unstated reason for a suggestion.
- Anything stamped `surfaced:` within the last **14 days**.
- The relationship's general state. He knows. Restating "things are strained" is
  commentary, not recall, and it turns the brief into something he avoids reading.
- Generic advice with no fragment behind it. If there is no real captured fact,
  output nothing. **Nothing is a valid and frequent answer**; an invented prompt
  is worse than silence (golden rule 4).

## Output

One line, in this shape:

```
**<the specific thing>** — <when she said it, or when it's happening>. _(logged <date>)_
```

Then stamp that fragment `_(surfaced: <today>)_` in `people/charlotte.md`.

Worked examples:

```
**Her mum's operation is on the 14th** — that's Thursday. She mentioned it on the 10th. _(logged 2026-07-10)_
**She was dreading that work presentation** — it was yesterday and you haven't asked how it went. _(logged 2026-07-11)_
```

Not this:

```
Remember that Charlotte values feeling understood.     <- commentary, no fragment
Try to be more attentive today.                        <- advice, not recall
Things have been difficult recently.                   <- he knows
```

## The capture side — the half that was missing

Surfacing only works if something gets captured, and Ben's stated failure is at
the capture end. So the other half lives in `file-inbox` and `evening-brief`:

- Any capture naming Charlotte, or plainly about her, becomes a dated fragment in
  her `## Log` — even half a sentence. Half a line beats nothing.
- If it carries **a date or deadline of hers**, keep that date in the fragment
  text, so this skill can find it later as an open loop.
- The evening brief's **## Charlotte** section reads the day's fragments back,
  which is also the moment he is most likely to remember one more.

## Assert

If `people/charlotte.md` has gained no new fragment in **14 days**, say so in your
output. That is not a quiet fortnight — it means the capture half has stopped and
the whole mechanism is running on a July interview. The system failing at the one
thing Ben named as his biggest problem must not fail silently (rule 5).
