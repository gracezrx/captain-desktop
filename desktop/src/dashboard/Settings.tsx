// Workspace settings: your profile, people and invites, agents, models and spend.

import {Bot, Check, Copy, Cpu, Plus, Users, UserRound} from 'lucide-react';
import {useEffect, useMemo, useState} from 'react';

import {Avatar, PORTRAITS, portraitSrc} from '../components/Avatar';
import {FieldLabel, ghostBtn, input, Modal, primaryBtn} from '../components/Modal';
import {api, errorMessage} from '../lib/api';
import {displayName, modelLabel, useStore} from '../lib/store';
import type {Agent, AgentTool, ModelInfo, Tier, UsageSummary, WorkspaceMember, WorkspaceRole} from '../lib/types';

type Tab = 'profile' | 'people' | 'agents' | 'models';

export function Settings({onClose, initial = 'people'}: {onClose: () => void; initial?: Tab}) {
    const ws = useStore((s) => s.workspace)!;
    const admin = ws.role === 'owner' || ws.role === 'admin';
    const [tab, setTab] = useState<Tab>(initial);
    const tabs: [Tab, string, React.ReactNode][] = [
        ['people', 'People', <Users key='p' size={15}/>],
        ['agents', 'Agents', <Bot key='a' size={15}/>],
        ['models', 'Models & spend', <Cpu key='m' size={15}/>],
        ['profile', 'Your profile', <UserRound key='u' size={15}/>],
    ];
    return (
        <Modal title={`${ws.name} settings`} onClose={onClose} width={760}>
            <div className='flex gap-5'>
                <nav className='w-40 shrink-0 space-y-0.5'>
                    {tabs.map(([id, label, icon]) => (
                        <button key={id} type='button' onClick={() => setTab(id)} className={`flex h-9 w-full items-center gap-2 rounded-xl px-2.5 text-left text-[13px] font-semibold ${tab === id ? 'bg-tint text-ink' : 'text-muted hover:bg-bg-subtle hover:text-ink'}`}>
                            {icon}{label}
                        </button>
                    ))}
                </nav>
                <div className='min-h-[440px] min-w-0 flex-1'>
                    {tab === 'people' && <People admin={admin}/>}
                    {tab === 'agents' && <Agents admin={admin}/>}
                    {tab === 'models' && <Models admin={admin}/>}
                    {tab === 'profile' && <Profile/>}
                </div>
            </div>
        </Modal>
    );
}

// ------------------------------------------------------------ people

function People({admin}: {admin: boolean}) {
    const ws = useStore((s) => s.workspace)!;
    const users = useStore((s) => s.users);
    const me = useStore((s) => s.me)!;
    const [members, setMembers] = useState<WorkspaceMember[]>([]);
    const [role, setRole] = useState<WorkspaceRole>('member');
    const [link, setLink] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [name, setName] = useState(ws.name);
    const [resetFor, setResetFor] = useState<{userId: string; url: string} | null>(null);

    const load = () => api.members(ws.id).then((r) => {
        setMembers(r.members);
        useStore.setState((s) => ({users: {...s.users, ...Object.fromEntries(r.users.map((u) => [u.id, u]))}}));
    }).catch((e) => setError(errorMessage(e)));
    useEffect(() => {
        void load();
    }, [ws.id]); // eslint-disable-line react-hooks/exhaustive-deps

    const makeLink = async () => {
        setError(null);
        try {
            const r = await api.createInvite(ws.id, {role, expiresInDays: 14});
            setLink(r.url);
            setCopied(false);
        } catch (e) {
            setError(errorMessage(e));
        }
    };
    const people = members.filter((m) => !users[m.userId]?.isBot);

    return (
        <div className='space-y-5'>
            {admin && (
                <section>
                    <h3 className='mb-2 text-[13px] font-extrabold text-ink'>Workspace</h3>
                    <div className='flex gap-2'>
                        <input className={input} value={name} onChange={(e) => setName(e.target.value)}/>
                        <button
                            type='button'
                            className={ghostBtn}
                            disabled={name.trim() === ws.name || !name.trim()}
                            onClick={() => api.updateWorkspace(ws.id, {name}).then((w) => useStore.setState((s) => ({workspace: w, workspaces: s.workspaces.map((x) => (x.id === w.id ? w : x))}))).catch((e) => setError(errorMessage(e)))}
                        >Rename</button>
                    </div>
                </section>
            )}
            {ws.role !== 'guest' && (
                <section>
                    <h3 className='mb-1 text-[13px] font-extrabold text-ink'>Invite people</h3>
                    <p className='mb-2 text-[12.5px] text-muted'>Anyone with the link can join for 14 days. Guests only see channels they're added to.</p>
                    <div className='flex gap-2'>
                        <select className={`${input} w-36`} value={role} onChange={(e) => setRole(e.target.value as WorkspaceRole)}>
                            <option value='member'>Member</option>
                            <option value='guest'>Guest</option>
                            {admin && <option value='admin'>Admin</option>}
                        </select>
                        <button type='button' className={primaryBtn} onClick={() => void makeLink()}>Create invite link</button>
                    </div>
                    {link && (
                        <div className='mt-2 flex items-center gap-2 rounded-xl bg-tint px-3 py-2'>
                            <code className='min-w-0 flex-1 truncate text-[12px] text-ink'>{link}</code>
                            <button type='button' className='inline-flex items-center gap-1 text-[12px] font-bold text-accent-text' onClick={() => void navigator.clipboard.writeText(link).then(() => setCopied(true))}>
                                {copied ? <><Check size={13}/> Copied</> : <><Copy size={13}/> Copy</>}
                            </button>
                        </div>
                    )}
                </section>
            )}
            <section>
                <h3 className='mb-2 text-[13px] font-extrabold text-ink'>People · {people.length}</h3>
                <div className='divide-y divide-line rounded-2xl ring-1 ring-line'>
                    {people.map((m) => {
                        const u = users[m.userId];
                        return (
                            <div key={m.userId} className='flex items-center gap-3 px-3 py-2'>
                                <Avatar user={u} size={30}/>
                                <span className='min-w-0 flex-1'>
                                    <span className='block truncate text-[13.5px] font-bold text-ink'>{displayName(u)}{m.userId === me.id ? ' (you)' : ''}</span>
                                    <span className='block truncate text-[12px] text-muted'>{u?.email ?? `@${u?.username ?? ''}`}</span>
                                </span>
                                {admin && m.userId !== me.id ? (
                                    <select
                                        className='h-8 rounded-lg bg-bg-subtle px-2 text-[12.5px] ring-1 ring-line'
                                        value={m.role}
                                        onChange={(e) => api.setRole(ws.id, m.userId, e.target.value as WorkspaceRole).then(load).catch((err) => setError(errorMessage(err)))}
                                    >
                                        {(['owner', 'admin', 'member', 'guest'] as const).map((r) => <option key={r} value={r}>{r[0].toUpperCase() + r.slice(1)}</option>)}
                                    </select>
                                ) : (
                                    <span className='text-[12px] font-semibold text-muted capitalize'>{m.role}</span>
                                )}
                                {admin && m.userId !== me.id && (ws.role === 'owner' || (m.role !== 'owner' && m.role !== 'admin')) && (
                                    <button
                                        type='button'
                                        title='Make a one-time link to set a new password'
                                        className='text-[12px] font-semibold text-muted hover:text-ink'
                                        onClick={() => api.resetLink(ws.id, m.userId).then((r) => setResetFor({userId: m.userId, url: r.url})).catch((err) => setError(errorMessage(err)))}
                                    >Reset password</button>
                                )}
                                {admin && m.userId !== me.id && (
                                    <button
                                        type='button'
                                        className='text-[12px] font-semibold text-muted hover:text-alert'
                                        onClick={() => confirm(`Remove ${displayName(u)} from the workspace?`) && api.removeMember(ws.id, m.userId).then(load).catch((err) => setError(errorMessage(err)))}
                                    >Remove</button>
                                )}
                            </div>
                        );
                    })}
                </div>
            </section>
            {resetFor && (
                <div className='rounded-2xl bg-tint px-3 py-2.5'>
                    <p className='text-[12.5px] text-ink'>Send this to {displayName(users[resetFor.userId])} privately. It works once, for 24 hours, and signs them out of other devices.</p>
                    <div className='mt-1.5 flex items-center gap-2'>
                        <code className='min-w-0 flex-1 truncate text-[12px] text-ink'>{resetFor.url}</code>
                        <button type='button' className='inline-flex items-center gap-1 text-[12px] font-bold text-accent-text' onClick={() => void navigator.clipboard.writeText(resetFor.url)}><Copy size={13}/> Copy</button>
                    </div>
                </div>
            )}
            {error && <p className='text-[12.5px] text-alert'>{error}</p>}
        </div>
    );
}

// ------------------------------------------------------------ agents

const TIERS: (Tier | 'auto')[] = ['auto', 'easy', 'balanced', 'hard'];
const TIER_HINT: Record<string, string> = {auto: 'The router decides per request', easy: 'Fast and cheap', balanced: 'Most work', hard: 'Deep reasoning, at a higher price'};

function Agents({admin}: {admin: boolean}) {
    const agents = useStore((s) => s.agents);
    const [editing, setEditing] = useState<Agent | 'new' | null>(null);
    const [tools, setTools] = useState<AgentTool[]>([]);
    const ws = useStore((s) => s.workspace)!;
    useEffect(() => {
        api.agents(ws.id).then((r) => setTools(r.tools)).catch(() => undefined);
    }, [ws.id]);
    const list = Object.values(agents).sort((a, b) => Number(b.isCoordinator) - Number(a.isCoordinator) || Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name));

    if (editing) {
        return <AgentForm agent={editing === 'new' ? null : editing} tools={tools} onDone={() => setEditing(null)}/>;
    }
    return (
        <div>
            <div className='mb-3 flex items-center'>
                <p className='flex-1 text-[12.5px] text-muted'>Mention an agent with @ in any chat, or message it directly. @captain plans bigger work across the team.</p>
                {admin && <button type='button' className={primaryBtn} onClick={() => setEditing('new')}><Plus size={14}/> New agent</button>}
            </div>
            <div className='space-y-2'>
                {list.map((a) => (
                    <button key={a.id} type='button' disabled={!admin} onClick={() => setEditing(a)} className={`flex w-full items-start gap-3 rounded-2xl p-3 text-left ring-1 ring-line ${admin ? 'hover:bg-bg-subtle' : ''} ${a.enabled ? '' : 'opacity-60'}`}>
                        <img src={portraitSrc(a.portrait, a.handle)} alt='' className='size-10 rounded-xl bg-white ring-1 ring-line'/>
                        <span className='min-w-0 flex-1'>
                            <span className='flex items-baseline gap-2'>
                                <span className='text-[14px] font-bold text-ink'>{a.name}</span>
                                <span className='text-[12px] text-muted'>@{a.handle}</span>
                                {!a.enabled && <span className='text-[11px] font-semibold text-muted'>off</span>}
                            </span>
                            <span className='block text-[12.5px] text-text'>{a.description}</span>
                            <span className='mt-1 block text-[11.5px] text-muted'>{a.model ? `Pinned to ${a.model}` : `Tier: ${a.tier}`} · {a.tools.length} tools</span>
                        </span>
                    </button>
                ))}
            </div>
        </div>
    );
}

function AgentForm({agent, tools, onDone}: {agent: Agent | null; tools: AgentTool[]; onDone: () => void}) {
    const ws = useStore((s) => s.workspace)!;
    const models = useStore((s) => s.models);
    const refreshAgents = useStore((s) => s.refreshAgents);
    const [handle, setHandle] = useState(agent?.handle ?? '');
    const [name, setName] = useState(agent?.name ?? '');
    const [description, setDescription] = useState(agent?.description ?? '');
    const [instructions, setInstructions] = useState(agent?.instructions ?? '');
    const [tier, setTier] = useState<Tier | 'auto'>(agent?.tier ?? 'auto');
    const [model, setModel] = useState<string>(agent?.model ?? '');
    const [picked, setPicked] = useState<string[]>(agent?.tools ?? ['search_workspace', 'read_url', 'create_document']);
    const [portrait, setPortrait] = useState(agent?.portrait ?? 'fox');
    const [enabled, setEnabled] = useState(agent?.enabled ?? true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const save = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            const body = {name, description, instructions, tier, model: model || null, tools: picked, portrait, enabled};
            if (agent) {
                await api.updateAgent(agent.id, body);
            } else {
                await api.createAgent(ws.id, {...body, handle});
            }
            await refreshAgents();
            onDone();
        } catch (err) {
            setError(errorMessage(err));
            setBusy(false);
        }
    };

    return (
        <form onSubmit={save} className='space-y-3'>
            <div className='flex items-center gap-2'>
                <button type='button' className='text-[12.5px] font-semibold text-muted hover:text-ink' onClick={onDone}>← Agents</button>
                <span className='text-[14px] font-extrabold text-ink'>{agent ? agent.name : 'New agent'}</span>
            </div>
            <div className='flex gap-1.5'>
                {(agent?.isCoordinator ? ['captain'] : PORTRAITS).map((p) => (
                    <button key={p} type='button' onClick={() => setPortrait(p)} className={`rounded-xl p-0.5 ring-2 ${portrait === p ? 'ring-accent' : 'ring-transparent'}`}>
                        <img src={portraitSrc(p)} alt={p} className='size-10 rounded-[10px] bg-white'/>
                    </button>
                ))}
            </div>
            <div className='grid grid-cols-2 gap-2'>
                <FieldLabel text='Name'><input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder='Support'/></FieldLabel>
                <FieldLabel text='Handle'><input className={input} value={handle} onChange={(e) => setHandle(e.target.value.toLowerCase())} disabled={Boolean(agent)} placeholder='support'/></FieldLabel>
            </div>
            <FieldLabel text='One-line description' hint='Captain uses this to decide who does what.'>
                <input className={input} value={description} onChange={(e) => setDescription(e.target.value)}/>
            </FieldLabel>
            <FieldLabel text='Instructions'>
                <textarea className={`${input} h-28 py-2`} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder='You answer customer questions kindly and briefly…'/>
            </FieldLabel>
            <div className='grid grid-cols-2 gap-2'>
                <FieldLabel text='Difficulty tier' hint={TIER_HINT[tier]}>
                    <select className={input} value={tier} onChange={(e) => setTier(e.target.value as Tier | 'auto')}>
                        {TIERS.map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
                    </select>
                </FieldLabel>
                <FieldLabel text='Model' hint='Pinning skips the router’s choice; it still falls back if the model fails.'>
                    <select className={input} value={model} onChange={(e) => setModel(e.target.value)}>
                        <option value=''>Let the router choose</option>
                        {models.map((m) => <option key={m.id} value={m.id} disabled={!m.configured}>{m.label}{m.configured ? '' : ' (no key)'}</option>)}
                    </select>
                </FieldLabel>
            </div>
            <div>
                <span className='mb-1 block text-[12px] font-bold text-muted'>Tools</span>
                <div className='grid grid-cols-2 gap-1.5'>
                    {tools.map((t) => (
                        <label key={t.name} className={`flex items-start gap-2 rounded-xl p-2 ring-1 ring-line ${t.available ? '' : 'opacity-50'}`} title={t.description}>
                            <input type='checkbox' className='mt-0.5 accent-[var(--accent)]' checked={picked.includes(t.name)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, t.name] : p.filter((x) => x !== t.name)))}/>
                            <span className='min-w-0'>
                                <span className='block text-[12.5px] font-bold text-ink'>{t.name.replace(/_/g, ' ')}{t.external ? ' · asks first' : ''}</span>
                                <span className='line-clamp-2 block text-[11px] text-muted'>{t.available ? t.description : 'Needs a key on the server'}</span>
                            </span>
                        </label>
                    ))}
                </div>
            </div>
            {agent && !agent.isCoordinator && (
                <label className='flex items-center gap-2 text-[13px] text-text'>
                    <input type='checkbox' className='accent-[var(--accent)]' checked={enabled} onChange={(e) => setEnabled(e.target.checked)}/> Agent is on
                </label>
            )}
            {error && <p className='text-[12.5px] text-alert'>{error}</p>}
            <div className='flex justify-end gap-2'>
                <button type='button' className={ghostBtn} onClick={onDone}>Cancel</button>
                <button type='submit' className={primaryBtn} disabled={busy || !name.trim() || !instructions.trim() || (!agent && !handle.trim())}>{busy ? 'Saving…' : agent ? 'Save' : 'Create agent'}</button>
            </div>
        </form>
    );
}

// ------------------------------------------------------------ models and spend

function Models({admin}: {admin: boolean}) {
    const ws = useStore((s) => s.workspace)!;
    const agents = useStore((s) => s.agents);
    const [models, setModels] = useState<ModelInfo[]>([]);
    const [demo, setDemo] = useState(false);
    const [usage, setUsage] = useState<UsageSummary | null>(null);
    const [budget, setBudget] = useState(ws.monthlyBudgetUsd === null ? '' : String(ws.monthlyBudgetUsd));
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        api.models(ws.id).then((r) => {
            setModels(r.models);
            setDemo(r.demoMode);
        }).catch((e) => setError(errorMessage(e)));
        if (admin) {
            api.usage(ws.id).then(setUsage).catch(() => undefined);
        }
    }, [ws.id, admin]);

    const byTier = useMemo(() => (['easy', 'balanced', 'hard'] as Tier[]).map((t) => [t, models.filter((m) => m.tiers.includes(t))] as const), [models]);
    const maxUsd = Math.max(0.0001, ...(usage?.byModel.map((m) => m.usd) ?? [0]));

    const saveBudget = async () => {
        setError(null);
        try {
            const v = budget.trim() === '' ? null : Number(budget);
            const w = await api.updateWorkspace(ws.id, {monthlyBudgetUsd: v});
            useStore.setState((s) => ({workspace: w, workspaces: s.workspaces.map((x) => (x.id === w.id ? w : x))}));
            setSaved(true);
        } catch (e) {
            setError(errorMessage(e));
        }
    };

    return (
        <div className='space-y-5'>
            {demo && (
                <div className='rounded-2xl bg-gold-tint px-4 py-3 text-[12.5px] text-gold-text'>
                    <span className='font-bold'>Demo mode.</span> No model key is set on the server, so agents give sample answers. Add a key such as <code>OPENROUTER_API_KEY</code> to the server's environment and restart it.
                </div>
            )}
            {admin && usage && (
                <section>
                    <h3 className='mb-2 text-[13px] font-extrabold text-ink'>This month</h3>
                    <div className='flex items-end gap-6'>
                        <div>
                            <div className='text-[28px] font-extrabold tracking-tight text-ink'>${usage.totalUsd.toFixed(2)}</div>
                            <div className='text-[12px] text-muted'>{usage.calls} model calls{usage.budgetUsd !== null ? ` · budget $${usage.budgetUsd.toFixed(2)}` : ''}</div>
                        </div>
                        <div className='ml-auto flex items-end gap-2'>
                            <FieldLabel text='Monthly budget (USD)'>
                                <input className={`${input} w-32`} value={budget} onChange={(e) => {
                                    setBudget(e.target.value);
                                    setSaved(false);
                                }} placeholder='No limit' inputMode='decimal'/>
                            </FieldLabel>
                            <button type='button' className={ghostBtn} onClick={() => void saveBudget()}>{saved ? 'Saved' : 'Save'}</button>
                        </div>
                    </div>
                    {usage.budgetUsd !== null && (
                        <div className='mt-2 h-1.5 overflow-hidden rounded-full bg-tint'>
                            <div className={`h-full rounded-full ${usage.totalUsd >= usage.budgetUsd ? 'bg-alert' : 'bg-accent'}`} style={{width: `${Math.min(100, (usage.totalUsd / Math.max(0.0001, usage.budgetUsd)) * 100)}%`}}/>
                        </div>
                    )}
                    {usage.byModel.length > 0 && (
                        <div className='mt-3 space-y-1.5'>
                            {usage.byModel.map((m) => (
                                <div key={m.modelId} className='grid grid-cols-[160px_1fr_auto] items-center gap-3 text-[12.5px]'>
                                    <span className='truncate font-semibold text-ink'>{modelLabel(models, m.modelId)}</span>
                                    <span className='h-2 overflow-hidden rounded-full bg-tint'><span className='block h-full rounded-full bg-accent' style={{width: `${(m.usd / maxUsd) * 100}%`}}/></span>
                                    <span className='w-28 text-right text-muted'>${m.usd.toFixed(3)} · {m.calls}×</span>
                                </div>
                            ))}
                        </div>
                    )}
                    {usage.byAgent.length > 0 && (
                        <p className='mt-2 text-[12px] text-muted'>
                            By agent: {usage.byAgent.map((a) => `${a.agentId ? agents[a.agentId]?.name ?? 'removed agent' : 'other'} $${a.usd.toFixed(3)}`).join(' · ')}
                        </p>
                    )}
                </section>
            )}
            <section>
                <h3 className='mb-1 text-[13px] font-extrabold text-ink'>Model routing</h3>
                <p className='mb-2 text-[12.5px] text-muted'>Each request gets a difficulty tier; the router tries that tier's models by priority, skips any that are failing, and falls back to the next. Models light up when their provider has a key on the server.</p>
                <div className='space-y-3'>
                    {byTier.map(([tier, list]) => (
                        <div key={tier}>
                            <div className='mb-1 text-[11.5px] font-bold tracking-wide text-muted uppercase'>{tier}</div>
                            <div className='flex flex-wrap gap-1.5'>
                                {list.map((m) => (
                                    <span
                                        key={m.id}
                                        title={`${m.provider} · $${m.priceInPerM}/$${m.priceOutPerM} per 1M tokens${m.lastError ? ` · last error: ${m.lastError}` : ''}`}
                                        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold ring-1 ${m.configured ? 'bg-surface text-ink ring-line' : 'bg-bg-subtle text-muted ring-transparent'}`}
                                    >
                                        <span className={`size-1.5 rounded-full ${!m.configured ? 'bg-slate-300' : m.healthy ? 'bg-emerald-500' : 'bg-amber-500'}`}/>
                                        {m.label}
                                        {m.vision && <span className='text-[10px] text-muted'>👁</span>}
                                    </span>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            </section>
            {error && <p className='text-[12.5px] text-alert'>{error}</p>}
        </div>
    );
}

// ------------------------------------------------------------ profile

function Profile() {
    const me = useStore((s) => s.me)!;
    const [name, setName] = useState(me.displayName);
    const [current, setCurrent] = useState('');
    const [next, setNext] = useState('');
    const [note, setNote] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    return (
        <div className='space-y-5'>
            <section className='space-y-2'>
                <h3 className='text-[13px] font-extrabold text-ink'>Name</h3>
                <div className='flex gap-2'>
                    <input className={input} value={name} onChange={(e) => setName(e.target.value)}/>
                    <button
                        type='button'
                        className={ghostBtn}
                        disabled={!name.trim() || name === me.displayName}
                        onClick={() => api.updateMe(name).then((u) => {
                            useStore.setState((s) => ({me: u, users: {...s.users, [u.id]: u}}));
                            setNote('Saved.');
                        }).catch((e) => setError(errorMessage(e)))}
                    >Save</button>
                </div>
                <p className='text-[12px] text-muted'>{me.email} · @{me.username}</p>
            </section>
            <section className='space-y-2'>
                <h3 className='text-[13px] font-extrabold text-ink'>Password</h3>
                <input className={input} type='password' value={current} onChange={(e) => setCurrent(e.target.value)} placeholder='Current password' autoComplete='current-password'/>
                <input className={input} type='password' value={next} onChange={(e) => setNext(e.target.value)} placeholder='New password (8+ characters)' autoComplete='new-password'/>
                <button
                    type='button'
                    className={ghostBtn}
                    disabled={!current || next.length < 8}
                    onClick={() => api.changePassword(current, next).then(() => {
                        setCurrent('');
                        setNext('');
                        setNote('Password changed. Other devices were signed out.');
                    }).catch((e) => setError(errorMessage(e)))}
                >Change password</button>
            </section>
            {note && <p className='text-[12.5px] text-accent-text'>{note}</p>}
            {error && <p className='text-[12.5px] text-alert'>{error}</p>}
        </div>
    );
}
