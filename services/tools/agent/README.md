# services/tools/agent/

The agent's own tools — what it can *choose to call*. `services/tools/` is the top-level home for
tool implementations, split by whose tools they are: `agent/` here, and `ui/` / `media/` / `chat/`
as those families move. Keeping the split at the top instead of nesting tools under the domain that
happens to host them first is what stops this from becoming `services/agent/tools/ui/` later.

## Layout

One directory per tool family, with `index.ts` inside it:

```
agent/<family>/index.ts
```

A family is a group that shares a data source or a permission tier. `subagent/` is the worker the
main agent spins up on the spot, and it will grow `cancel.ts` / `list.ts` before long. A tool that
nothing else will ever share may stay a flat `tools/<name>.ts` until it earns a second file.

## What belongs here, and what does not

Here: the orchestration a tool performs — recursion ceilings, the child's permission profile,
retry policy, how a failure is normalised — and the schema-shaped decisions that come with it.

Not here: the tool list. The `define({...})` calls stay in the bundle that assembles the registry
(`public/shared/agent/tools.js` today), because that file is the one place that decides which tools
a profile exposes. Splitting the list across directories would make “what does `core` see” a grep.

## Vocabulary

Three kinds of "another agent" exist and they are not interchangeable:

| kind | who starts it | lifetime | code |
|---|---|---|---|
| peer | the user, through a scene or the council panel | a role card, long-lived | `services/agent/peer-calls.ts` |
| sub-agent | the main agent, as a tool call | one task, then discarded | `tools/subagent/` |
| council seat | fixed — three seats on one board | process lifetime | `services/agent/council-tools.ts` |

`peer-calls.ts` carries the same note. Keeping both is deliberate: this is the distinction that
keeps getting made wrong, in both directions.
