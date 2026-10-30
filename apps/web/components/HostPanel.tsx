'use client';

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Socket } from 'socket.io-client';
import type { QuizOption, CtaForm, CtaFormFieldType } from '@webinar/shared';
import { useRoomStore } from '@/store/roomStore';
import { endpoints } from '@/lib/api';
import { CtaFollowUp } from './CtaFollowUp';

interface AdminQuiz {
  id: string;
  question: string;
  options: QuizOption[];
  correctOptionId: string | null;
  timeLimitSecs: number;
  answerCount: number;
}

interface AdminPoll {
  id: string;
  question: string;
  options: QuizOption[];
  timeLimitSecs: number;
  voteCount: number;
}

interface AdminCta {
  id: string;
  title: string;
  description: string | null;
  buttonText: string;
  priceOverridePaise: number | null;
  externalUrl: string | null;
  course: { title: string; pricePaise: number; currency: string } | null;
  /** How many distinct people have opened this offer. */
  clickCount: number;
  formEnabled: boolean;
  formIntro: string | null;
  formSubmitText: string;
  form: CtaForm | null;
}

type Tab = 'quiz' | 'poll' | 'offer';

interface DraftOption {
  id: string;
  text: string;
}

/** One row in the offer form builder. */
interface DraftField {
  key: string;
  label: string;
  type: CtaFormFieldType;
  isRequired: boolean;
  placeholder: string;
  /** Comma-separated in the editor, split into options on save. */
  options: string;
}

const LETTERS = ['a', 'b', 'c', 'd', 'e', 'f'];

const FIELD_TYPE_LABELS: Record<CtaFormFieldType, string> = {
  text: 'Short text',
  number: 'Number',
  email: 'Email',
  phone: 'Phone',
  textarea: 'Long text',
  select: 'Dropdown',
  checkbox: 'Checkbox',
};

/**
 * Host/moderator controls for launching quizzes and pushing offers.
 * Only rendered for staff roles.
 */
export function HostPanel({ socket }: { socket: React.RefObject<Socket | null> }) {
  const webinarId = useRoomStore((s) => s.webinarId);
  const role = useRoomStore((s) => s.role);
  const activeQuiz = useRoomStore((s) => s.activeQuiz);
  const quizResults = useRoomStore((s) => s.quizResults);
  const activePoll = useRoomStore((s) => s.activePoll);
  const pollResults = useRoomStore((s) => s.pollResults);
  const activeCta = useRoomStore((s) => s.activeCta);
  /**
   * Live click tallies, pushed by the server on every click.
   *
   * Read from the store rather than from `ctas` because the list is fetched
   * once when the panel opens — a host watching the count needs it to move
   * without reopening the panel.
   */
  const ctaClickCounts = useRoomStore((s) => s.ctaClickCounts);

  // A moderator runs the room but does not own it: quizzes and offers are
  // theirs to launch, ending the webinar is not. The server enforces this
  // too — hiding the button just avoids offering an action that will fail.
  const canEndWebinar = role === 'HOST' || role === 'ADMIN';

  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('quiz');
  const [quizzes, setQuizzes] = useState<AdminQuiz[]>([]);
  const [polls, setPolls] = useState<AdminPoll[]>([]);
  const [ctas, setCtas] = useState<AdminCta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [ending, setEnding] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const startedAt = useRoomStore((s) => s.startedAt);
  const [recBusy, setRecBusy] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);
  const [lastRecording, setLastRecording] = useState<{ id: string; durationMs: number } | null>(null);
  const recording = useRoomStore((s) => s.recording);
  const peers = useRoomStore((s) => s.peers);
  const spotlightedPeerId = useRoomStore((s) => s.spotlightedPeerId);
  const [stageMsg, setStageMsg] = useState<string | null>(null);

  /** Speakers the host can put on stage — staff are already visible. */
  const speakers = Object.values(peers).filter((p) => p.isApprovedSpeaker);

  function spotlight(peerId: string | null) {
    if (!socket.current) return;
    setStageMsg(null);
    socket.current.emit(
      'spotlight',
      { peerId },
      (res: { ok: boolean; error?: string }) => {
        if (!res?.ok) setStageMsg(res?.error ?? 'Could not change the spotlight');
      }
    );
  }

  function muteAll() {
    if (!socket.current) return;
    setStageMsg(null);
    socket.current.emit(
      'muteAll',
      (res: { ok: boolean; error?: string; data?: { muted: number } }) => {
        if (!res?.ok) {
          setStageMsg(res?.error ?? 'Could not mute the room');
          return;
        }
        const n = res.data?.muted ?? 0;
        setStageMsg(n === 0 ? 'No speakers to mute' : `Muted ${n} speaker${n === 1 ? '' : 's'}`);
      }
    );
  }

  const load = useCallback(async () => {
    if (!webinarId) return;
    setLoading(true);
    setError(null);
    try {
      const [q, p, c] = await Promise.all([
        endpoints.quizzes(webinarId) as Promise<{ quizzes: AdminQuiz[] }>,
        endpoints.polls(webinarId) as Promise<{ polls: AdminPoll[] }>,
        endpoints.ctas(webinarId) as Promise<{ ctas: AdminCta[] }>,
      ]);
      setQuizzes(q.quizzes);
      setPolls(p.polls);
      setCtas(c.ctas);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load engagement assets');
    } finally {
      setLoading(false);
    }
  }, [webinarId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const launch = (quizId: string) =>
    socket.current?.emit('quizLaunch', { quizId }, (res: { ok: boolean; error?: string }) => {
      if (!res?.ok) setError(res?.error ?? 'Could not launch quiz');
    });

  const close = (quizId: string) =>
    socket.current?.emit('quizClose', { quizId }, () => {});

  const launchPoll = (pollId: string) =>
    socket.current?.emit('pollLaunch', { pollId }, (res: { ok: boolean; error?: string }) => {
      if (!res?.ok) setError(res?.error ?? 'Could not launch poll');
    });

  const closePoll = (pollId: string) =>
    socket.current?.emit('pollClose', { pollId }, () => {});

  const showCta = (ctaId: string) =>
    socket.current?.emit('ctaShow', { ctaId }, (res: { ok: boolean; error?: string }) => {
      if (!res?.ok) setError(res?.error ?? 'Could not show offer');
    });

  const hideCta = () => socket.current?.emit('ctaHide', () => {});

  /* ── inline authoring ─────────────────────────────────────
   * A host should not have to leave the live room, open the admin console and
   * come back just to write a question. These drafts let them build a quiz, a
   * poll or an offer in place and launch it immediately.
   */
  const [composing, setComposing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<DraftOption[]>([
    { id: 'a', text: '' },
    { id: 'b', text: '' },
  ]);
  const [correct, setCorrect] = useState('a');
  const [limit, setLimit] = useState(30);

  const [ctaTitle, setCtaTitle] = useState('');
  const [ctaDesc, setCtaDesc] = useState('');
  const [ctaButton, setCtaButton] = useState('Enroll Now');
  const [ctaPrice, setCtaPrice] = useState('');
  const [ctaUrl, setCtaUrl] = useState('');

  /* ── pre-payment form builder ─────────────────────────────
   * The form is what turns a click into a lead. It is authored here, in the
   * same composer as the offer, because a host who has just written the offer
   * is the only person who knows what they need to ask before taking money.
   */
  const [formEnabled, setFormEnabled] = useState(false);
  const [formIntro, setFormIntro] = useState('');
  const [formSubmitText, setFormSubmitText] = useState('Continue to payment');
  const [formFields, setFormFields] = useState<DraftField[]>([]);
  /**
   * The id of the quiz, poll or offer currently loaded into the composer, or
   * null when composing a new one.
   *
   * One piece of state rather than three, because only one tab is visible at a
   * time — a host cannot be editing a quiz and a poll simultaneously, and three
   * parallel flags would only create the question of which one wins.
   */
  const [editingId, setEditingId] = useState<string | null>(null);
  /**
   * True when the composer was opened from an offer's "Edit form" button, so
   * only the form is on screen. "Edit offer" loads the whole thing.
   */
  const [formOnly, setFormOnly] = useState(false);
  /**
   * Which offer's follow-up list is open.
   *
   * A separate piece of state from `editingId` because the two are different
   * jobs: one edits what the offer asks, the other reads who answered. Opening
   * one must not disturb the other.
   */
  const [followUpFor, setFollowUpFor] = useState<string | null>(null);
  /** Which row is awaiting a delete confirmation. */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  function addField() {
    setFormFields((prev) =>
      prev.length >= 20
        ? prev
        : [
            ...prev,
            {
              key: `f${Date.now()}${prev.length}`,
              label: '',
              type: 'text',
              isRequired: false,
              placeholder: '',
              options: '',
            },
          ]
    );
  }

  function updateField(key: string, patch: Partial<DraftField>) {
    setFormFields((prev) => prev.map((f) => (f.key === key ? { ...f, ...patch } : f)));
  }

  function removeField(key: string) {
    setFormFields((prev) => prev.filter((f) => f.key !== key));
  }

  /** Turn the editor rows into the payload the server expects. */
  function formPayload() {
    return {
      formEnabled,
      formIntro: formIntro.trim() || null,
      formSubmitText: formSubmitText.trim() || 'Continue to payment',
      formFields: formFields
        .filter((f) => f.label.trim())
        .map((f) => ({
          label: f.label.trim(),
          type: f.type,
          isRequired: f.isRequired,
          placeholder: f.placeholder.trim() || null,
          // Options only mean something for a dropdown; sending them for a
          // text field would resurrect them if the type is switched back.
          options:
            f.type === 'select'
              ? f.options
                  .split(',')
                  .map((o) => o.trim())
                  .filter(Boolean)
                  .map((o) => ({ label: o, value: o }))
              : undefined,
        })),
    };
  }

  function resetFormDraft() {
    setFormEnabled(false);
    setFormIntro('');
    setFormSubmitText('Continue to payment');
    setFormFields([]);
    setEditingId(null);
    setFormOnly(false);
  }

  /** Load an existing offer's form into the builder. */
  function editForm(cta: AdminCta) {
    setEditingId(cta.id);
    setFormOnly(true);
    setFormEnabled(cta.formEnabled);
    setFormIntro(cta.formIntro ?? '');
    setFormSubmitText(cta.formSubmitText || 'Continue to payment');
    setFormFields(
      (cta.form?.fields ?? []).map((f, i) => ({
        key: `e${i}${f.id}`,
        label: f.label,
        type: f.type,
        isRequired: f.isRequired,
        placeholder: f.placeholder ?? '',
        options: f.options.map((o) => o.label).join(', '),
      }))
    );
    setComposing(true);
    setError(null);
  }

  /** Load a whole offer — copy, price, link and form — into the composer. */
  function editOffer(cta: AdminCta) {
    setEditingId(cta.id);
    setFormOnly(false);
    setCtaTitle(cta.title);
    setCtaDesc(cta.description ?? '');
    setCtaButton(cta.buttonText || 'Enroll Now');
    setCtaPrice(
      cta.priceOverridePaise === null ? '' : String(cta.priceOverridePaise / 100)
    );
    setCtaUrl(cta.externalUrl ?? '');
    setFormEnabled(cta.formEnabled);
    setFormIntro(cta.formIntro ?? '');
    setFormSubmitText(cta.formSubmitText || 'Continue to payment');
    setFormFields(
      (cta.form?.fields ?? []).map((f, i) => ({
        key: `e${i}${f.id}`,
        label: f.label,
        type: f.type,
        isRequired: f.isRequired,
        placeholder: f.placeholder ?? '',
        options: f.options.map((o) => o.label).join(', '),
      }))
    );
    setComposing(true);
    setError(null);
  }

  /** Load a quiz into the composer. */
  function editQuiz(quiz: AdminQuiz) {
    setEditingId(quiz.id);
    setFormOnly(false);
    setQuestion(quiz.question);
    setOptions(quiz.options.map((o) => ({ id: o.id, text: o.text })));
    setCorrect(quiz.correctOptionId ?? quiz.options[0]?.id ?? 'a');
    setLimit(quiz.timeLimitSecs);
    setComposing(true);
    setError(null);
  }

  /** Load a poll into the composer. */
  function editPoll(poll: AdminPoll) {
    setEditingId(poll.id);
    setFormOnly(false);
    setQuestion(poll.question);
    setOptions(poll.options.map((o) => ({ id: o.id, text: o.text })));
    setLimit(poll.timeLimitSecs);
    setComposing(true);
    setError(null);
  }

  async function saveForm() {
    if (!editingId) return;
    setSaving(true);
    setError(null);
    try {
      await endpoints.updateCta(editingId, formPayload());
      await load();
      setComposing(false);
      resetFormDraft();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the form');
    } finally {
      setSaving(false);
    }
  }

  /**
   * Delete a quiz, poll or offer.
   *
   * The confirmation is inline rather than a `window.confirm` because the panel
   * is a portal over a live room — a native dialog would steal focus from the
   * call and, on some browsers, drop the socket's audio context.
   */
  async function removeRow(kind: Tab, id: string) {
    setDeleting(true);
    setError(null);
    try {
      if (kind === 'quiz') await endpoints.deleteQuiz(id);
      else if (kind === 'poll') await endpoints.deletePoll(id);
      else await endpoints.deleteCta(id);
      setConfirmDelete(null);
      // A deleted offer cannot stay on screen for the room.
      if (kind === 'offer' && activeCta?.id === id) hideCta();
      if (followUpFor === id) setFollowUpFor(null);
      if (editingId === id) {
        setComposing(false);
        resetDraft();
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete it');
    } finally {
      setDeleting(false);
    }
  }

  const resetDraft = useCallback(() => {
    setQuestion('');
    setOptions([
      { id: 'a', text: '' },
      { id: 'b', text: '' },
    ]);
    setCorrect('a');
    // A quiz needs a countdown; a poll is usually left open until the host
    // closes it, so the two tabs get different defaults.
    setLimit(tab === 'poll' ? 0 : 30);
    setCtaTitle('');
    setCtaDesc('');
    setCtaButton('Enroll Now');
    setCtaPrice('');
    setCtaUrl('');
    resetFormDraft();
    setError(null);
  }, [tab]);
  useEffect(() => {
    setComposing(false);
    resetDraft();
  }, [tab, resetDraft]);

  function setOptionText(index: number, text: string) {
    setOptions((prev) => prev.map((o, i) => (i === index ? { ...o, text } : o)));
  }

  function addOption() {
    setOptions((prev) =>
      prev.length >= 6 ? prev : [...prev, { id: LETTERS[prev.length], text: '' }]
    );
  }

  function removeOption(index: number) {
    setOptions((prev) => {
      if (prev.length <= 2) return prev;
      // Re-letter so ids stay contiguous — the tally and the correct-answer
      // marker both key off these.
      const next = prev.filter((_, i) => i !== index).map((o, i) => ({ ...o, id: LETTERS[i] }));
      if (!next.some((o) => o.id === correct)) setCorrect(next[0].id);
      return next;
    });
  }

  /** Shared validation for the quiz and poll composers. */
  function draftOptions(): DraftOption[] | null {
    const filled = options.map((o) => ({ id: o.id, text: o.text.trim() })).filter((o) => o.text);
    if (question.trim().length < 3) {
      setError('Write a question first.');
      return null;
    }
    if (filled.length < 2) {
      setError('Add at least two options.');
      return null;
    }
    return filled;
  }

  async function createQuiz() {
    if (!webinarId) return;
    const opts = draftOptions();
    if (!opts) return;
    setSaving(true);
    setError(null);
    try {
      const payload = {
        question: question.trim(),
        options: opts,
        correctOptionId: opts.some((o) => o.id === correct) ? correct : opts[0].id,
        timeLimitSecs: limit,
      };

      // Editing saves in place and does NOT relaunch: the host is fixing a
      // typo, not asking the room to answer again.
      if (editingId) {
        await endpoints.updateQuiz(editingId, payload);
        await load();
        setComposing(false);
        resetDraft();
        return;
      }

      const res = (await endpoints.createQuiz(webinarId, payload)) as {
        quiz?: { id?: string };
      };
      await load();
      setComposing(false);
      resetDraft();
      // Creating a quiz mid-session is almost always followed by launching it,
      // so do both — the host can still close it from the list.
      if (res.quiz?.id) launch(res.quiz.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the quiz');
    } finally {
      setSaving(false);
    }
  }

  async function createPoll() {
    if (!webinarId) return;
    const opts = draftOptions();
    if (!opts) return;
    setSaving(true);
    setError(null);
    try {
      const payload = {
        question: question.trim(),
        options: opts,
        // 0 means "stay open until I close it", which is the sane default for
        // a poll asked mid-session.
        timeLimitSecs: limit,
      };

      if (editingId) {
        await endpoints.updatePoll(editingId, payload);
        await load();
        setComposing(false);
        resetDraft();
        return;
      }

      const res = (await endpoints.createPoll(webinarId, payload)) as {
        poll?: { id?: string };
      };
      await load();
      setComposing(false);
      resetDraft();
      if (res.poll?.id) launchPoll(res.poll.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the poll');
    } finally {
      setSaving(false);
    }
  }

  async function createOffer() {
    if (!webinarId) return;
    if (ctaTitle.trim().length < 2) {
      setError('Give the offer a title.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const rupees = Number(ctaPrice);
      const payload = {
        title: ctaTitle.trim(),
        description: ctaDesc.trim() || undefined,
        buttonText: ctaButton.trim() || 'Enroll Now',
        priceOverridePaise:
          ctaPrice.trim() && Number.isFinite(rupees) && rupees >= 0
            ? Math.round(rupees * 100)
            : undefined,
        externalUrl: ctaUrl.trim() || undefined,
        ...formPayload(),
      };

      // Editing an offer must not re-push it to the room: the host may be
      // correcting a price, and flashing the card at everyone would be noise.
      if (editingId) {
        await endpoints.updateCta(editingId, payload);
        await load();
        setComposing(false);
        resetDraft();
        return;
      }

      const res = (await endpoints.createCta(webinarId, payload)) as {
        cta?: { id?: string };
      };
      await load();
      setComposing(false);
      resetDraft();
      if (res.cta?.id) showCta(res.cta.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the offer');
    } finally {
      setSaving(false);
    }
  }

  /**
   * Starts or stops capture. The server broadcasts `recordingState`, which the
   * store already listens for, so the button label follows the real state
   * rather than a local guess — two hosts in the same room stay in sync.
   */
  function toggleRecording() {
    if (!socket.current) return;
    setRecBusy(true);
    setRecError(null);

    if (recording) {
      socket.current.emit(
        'recordingStop',
        (res: {
          ok: boolean;
          error?: string;
          data?: { recordingId: string; durationMs: number };
        }) => {
          setRecBusy(false);
          if (!res?.ok) {
            setRecError(res?.error ?? 'Could not stop recording');
            return;
          }
          if (res.data?.recordingId) {
            setLastRecording({
              id: res.data.recordingId,
              durationMs: res.data.durationMs ?? 0,
            });
          }
        }
      );
      return;
    }

    socket.current.emit(
      'recordingStart',
      (res: { ok: boolean; error?: string; data?: { recordingId: string } }) => {
        setRecBusy(false);
        if (!res?.ok) {
          setRecError(res?.error ?? 'Could not start recording');
          return;
        }
        setLastRecording(null);
      }
    );
  }

  function endWebinar() {
    if (!socket.current) return;
    setEnding(true);
    socket.current.emit('webinarEnd', (res: { ok: boolean; error?: string }) => {
      setEnding(false);
      if (!res?.ok) {
        setError(res?.error ?? 'Could not end the webinar');
        return;
      }
      setConfirmEnd(false);
      setOpen(false);
    });
  }

  /**
   * Opens the session for everyone waiting in the room.
   *
   * Until this is pressed, participants see a waiting screen rather than an
   * empty stage — which is the point: the host gets to check their camera and
   * slides without an audience watching them do it.
   */
  function startWebinar() {
    if (!socket.current) return;
    setStarting(true);
    setStartError(null);
    socket.current.emit(
      'webinarStart',
      (res: { ok: boolean; error?: string }) => {
        setStarting(false);
        if (!res?.ok) setStartError(res?.error ?? 'Could not start the webinar');
      }
    );
  }

  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        className="btn-ghost px-2.5 py-1.5 text-xs"
        aria-label="Host tools"
        title="Host tools"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1M7.7 16.3l-2.1 2.1" strokeLinecap="round" />
        </svg>
        <span className="hidden sm:inline">Host tools</span>
      </button>

      {open &&
        createPortal(
          // A right-anchored drawer rather than a centred modal: the host is
          // running a live room, and a dialog over the middle of the stage
          // hides the very thing they are reacting to. The portal target is
          // still `document.body` because the room layout has `backdrop-filter`
          // ancestors, which would otherwise trap a `fixed` child.
          <div className="fixed inset-0 z-40 flex justify-end">
            {/* Click-away backdrop, a sibling rather than a wrapper so the
                panel itself is never inside the click target. */}
            <button
              onClick={() => setOpen(false)}
              aria-label="Close host tools"
              tabIndex={-1}
              className="absolute inset-0 cursor-default bg-black/50 backdrop-blur-sm"
            />

            <aside className="relative flex h-full w-full max-w-md flex-col border-l border-white/10 bg-ink-900 shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
              <h2 className="text-sm font-semibold text-white">Host tools</h2>
              <button
                onClick={() => setOpen(false)}
                className="rounded-lg p-1.5 text-slate-400 transition hover:bg-white/5 hover:text-white"
                aria-label="Close host tools"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            <div className="flex border-b border-white/10">
              {(['quiz', 'poll', 'offer'] as Tab[]).map((t) => {
                // Each tab carries its own tally and a live dot, so the host can
                // see at a glance that a poll is still running or that an offer
                // is on screen without opening the tab to check.
                const count =
                  t === 'quiz' ? quizzes.length : t === 'poll' ? polls.length : ctas.length;
                const live =
                  t === 'quiz'
                    ? Boolean(activeQuiz)
                    : t === 'poll'
                      ? Boolean(activePoll)
                      : Boolean(activeCta);
                return (
                  <button
                    key={t}
                    onClick={() => {
                      setTab(t);
                      // Leaving the Offers tab must drop the follow-up view,
                      // otherwise coming back lands on a stale list for an offer
                      // the host was no longer looking at.
                      setFollowUpFor(null);
                    }}
                    className={`flex flex-1 items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-semibold transition ${
                      tab === t
                        ? 'border-b-2 border-brand-400 text-white'
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    <span>{t === 'quiz' ? 'Quizzes' : t === 'poll' ? 'Polls' : 'Offers'}</span>
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${
                        tab === t ? 'bg-brand-500/25 text-brand-200' : 'bg-white/10 text-slate-400'
                      }`}
                    >
                      {count}
                    </span>
                    {live && (
                      <span
                        className="h-1.5 w-1.5 rounded-full bg-mint-400"
                        title="Live right now"
                        aria-label="Live right now"
                      />
                    )}
                  </button>
                );
              })}
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {error && (
                <p className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                  {error}
                </p>
              )}

              {loading && <p className="py-6 text-center text-xs text-slate-500">Loading…</p>}

              {/* ── inline composer ─────────────────────── */}
              {!loading && (
                <div className="mb-3 flex items-center justify-between gap-2">
                  <p className="text-[11px] text-slate-500">
                    {composing
                      ? tab === 'offer'
                        ? editingId
                          ? formOnly
                            ? 'Edit form'
                            : 'Edit offer'
                          : 'New offer'
                        : editingId
                          ? tab === 'poll'
                            ? 'Edit poll'
                            : 'Edit quiz'
                          : tab === 'poll'
                            ? 'New poll'
                            : 'New quiz'
                      : tab === 'offer'
                        ? `${ctas.length} offer${ctas.length === 1 ? '' : 's'}`
                        : tab === 'poll'
                          ? `${polls.length} poll${polls.length === 1 ? '' : 's'}`
                          : `${quizzes.length} quiz${quizzes.length === 1 ? '' : 'zes'}`}
                  </p>
                  <button
                    onClick={() => {
                      setComposing((v) => !v);
                      resetDraft();
                    }}
                    className="btn-ghost px-2.5 py-1 text-[11px]"
                  >
                    {composing ? 'Cancel' : '+ New'}
                  </button>
                </div>
              )}

              {!loading && composing && tab !== 'offer' && (
                <div className="space-y-3 rounded-xl border border-white/10 bg-white/[0.03] p-3">
                  <div>
                    <label className="label text-[10px]" htmlFor="draft-question">
                      Question
                    </label>
                    <input
                      id="draft-question"
                      className="input py-1.5 text-xs"
                      value={question}
                      onChange={(e) => setQuestion(e.target.value)}
                      placeholder="What should we cover next?"
                      maxLength={500}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="label text-[10px]">Options</label>
                    {options.map((opt, i) => (
                      <div key={opt.id} className="flex items-center gap-1.5">
                        {tab === 'quiz' ? (
                          <button
                            type="button"
                            onClick={() => setCorrect(opt.id)}
                            title="Mark as the correct answer"
                            className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-bold transition ${
                              correct === opt.id
                                ? 'bg-mint-500 text-black'
                                : 'bg-white/10 text-slate-400 hover:bg-white/20'
                            }`}
                          >
                            {opt.id.toUpperCase()}
                          </button>
                        ) : (
                          <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-white/10 text-[10px] font-bold text-slate-400">
                            {opt.id.toUpperCase()}
                          </span>
                        )}
                        <input
                          className="input flex-1 py-1 text-xs"
                          value={opt.text}
                          onChange={(e) => setOptionText(i, e.target.value)}
                          placeholder={`Option ${opt.id.toUpperCase()}`}
                          maxLength={200}
                        />
                        <button
                          type="button"
                          onClick={() => removeOption(i)}
                          disabled={options.length <= 2}
                          className="shrink-0 rounded p-1 text-slate-500 transition hover:text-red-400 disabled:opacity-30"
                          aria-label={`Remove option ${opt.id.toUpperCase()}`}
                        >
                          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
                          </svg>
                        </button>
                      </div>
                    ))}
                    {options.length < 6 && (
                      <button
                        type="button"
                        onClick={addOption}
                        className="text-[11px] font-medium text-brand-300 transition hover:text-brand-200"
                      >
                        + Add option
                      </button>
                    )}
                  </div>

                  <div>
                    <label className="label text-[10px]" htmlFor="draft-limit">
                      {tab === 'poll' ? 'Time limit (0 = open until closed)' : 'Time limit (seconds)'}
                    </label>
                    <input
                      id="draft-limit"
                      type="number"
                      className="input py-1.5 text-xs"
                      value={limit}
                      onChange={(e) => setLimit(Number(e.target.value))}
                      min={tab === 'poll' ? 0 : 5}
                      max={tab === 'poll' ? 3600 : 300}
                    />
                  </div>

                  {tab === 'quiz' && (
                    <p className="text-[10px] text-slate-500">
                      Tap a letter to mark the correct answer — currently{' '}
                      <span className="font-semibold text-mint-400">{correct.toUpperCase()}</span>.
                    </p>
                  )}

                  <button
                    onClick={tab === 'poll' ? createPoll : createQuiz}
                    disabled={saving}
                    className="btn-primary w-full py-1.5 text-xs disabled:opacity-50"
                  >
                    {saving
                      ? 'Saving…'
                      : editingId
                        ? 'Save changes'
                        : tab === 'poll'
                          ? 'Create & launch poll'
                          : 'Create & launch quiz'}
                  </button>
                </div>
              )}

              {!loading && composing && tab === 'offer' && (
                <div className="space-y-3 rounded-xl border border-white/10 bg-white/[0.03] p-3">
                  {editingId && (
                    <p className="rounded-lg bg-brand-500/10 px-2.5 py-1.5 text-[10px] text-brand-200">
                      {formOnly
                        ? 'Editing the form on an existing offer. The offer itself is unchanged.'
                        : 'Editing an existing offer. Saving updates it in place — it is not re-shown to the room.'}
                    </p>
                  )}
                  {!formOnly && (
                    <>
                  <div>
                    <label className="label text-[10px]" htmlFor="draft-cta-title">
                      Title
                    </label>
                    <input
                      id="draft-cta-title"
                      className="input py-1.5 text-xs"
                      value={ctaTitle}
                      onChange={(e) => setCtaTitle(e.target.value)}
                      placeholder="Enroll in the full course"
                      maxLength={160}
                    />
                  </div>
                  <div>
                    <label className="label text-[10px]" htmlFor="draft-cta-desc">
                      Description
                    </label>
                    <textarea
                      id="draft-cta-desc"
                      className="input py-1.5 text-xs"
                      rows={2}
                      value={ctaDesc}
                      onChange={(e) => setCtaDesc(e.target.value)}
                      placeholder="What do they get?"
                      maxLength={1000}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="label text-[10px]" htmlFor="draft-cta-button">
                        Button text
                      </label>
                      <input
                        id="draft-cta-button"
                        className="input py-1.5 text-xs"
                        value={ctaButton}
                        onChange={(e) => setCtaButton(e.target.value)}
                        maxLength={40}
                      />
                    </div>
                    <div>
                      <label className="label text-[10px]" htmlFor="draft-cta-price">
                        Price (₹)
                      </label>
                      <input
                        id="draft-cta-price"
                        type="number"
                        className="input py-1.5 text-xs"
                        value={ctaPrice}
                        onChange={(e) => setCtaPrice(e.target.value)}
                        placeholder="4999"
                        min={0}
                      />
                    </div>
                  </div>
                  <div>
                    <label className="label text-[10px]" htmlFor="draft-cta-url">
                      External link (optional)
                    </label>
                    <input
                      id="draft-cta-url"
                      className="input py-1.5 text-xs"
                      value={ctaUrl}
                      onChange={(e) => setCtaUrl(e.target.value)}
                      placeholder="https://…"
                    />
                  </div>
                    </>
                  )}

                  {/* ── pre-payment form ──────────────────────── */}
                  <div className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5">
                    <label className="flex cursor-pointer items-center justify-between gap-2">
                      <span className="text-[11px] font-medium text-slate-200">
                        Ask a form before payment
                      </span>
                      <input
                        type="checkbox"
                        checked={formEnabled}
                        onChange={(e) => setFormEnabled(e.target.checked)}
                        className="h-4 w-4 rounded border-white/20 bg-white/5"
                      />
                    </label>
                    <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
                      The card stays collapsed until someone clicks. Only then does the form
                      appear, so you are asking details of people who already want it.
                    </p>

                    {formEnabled && (
                      <div className="mt-3 space-y-2.5">
                        <div>
                          <label className="label text-[10px]" htmlFor="draft-cta-form-intro">
                            Intro (optional)
                          </label>
                          <textarea
                            id="draft-cta-form-intro"
                            className="input py-1.5 text-xs"
                            rows={2}
                            value={formIntro}
                            onChange={(e) => setFormIntro(e.target.value)}
                            placeholder="We just need a few details to send your access."
                            maxLength={500}
                          />
                        </div>

                        {formFields.map((field, i) => (
                          <div
                            key={field.key}
                            className="space-y-1.5 rounded-lg border border-white/10 bg-white/[0.03] p-2"
                          >
                            <div className="flex items-center gap-1.5">
                              <input
                                className="input flex-1 py-1 text-xs"
                                value={field.label}
                                onChange={(e) => updateField(field.key, { label: e.target.value })}
                                placeholder={`Question ${i + 1}`}
                                maxLength={120}
                              />
                              <button
                                onClick={() => removeField(field.key)}
                                aria-label="Remove field"
                                className="rounded p-1 text-slate-500 hover:bg-white/10 hover:text-red-400"
                              >
                                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                                  <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
                                </svg>
                              </button>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <select
                                className="input flex-1 py-1 text-[11px]"
                                value={field.type}
                                onChange={(e) =>
                                  updateField(field.key, {
                                    type: e.target.value as CtaFormFieldType,
                                  })
                                }
                              >
                                {(Object.keys(FIELD_TYPE_LABELS) as CtaFormFieldType[]).map((t) => (
                                  <option key={t} value={t}>
                                    {FIELD_TYPE_LABELS[t]}
                                  </option>
                                ))}
                              </select>
                              <label className="flex shrink-0 items-center gap-1 text-[10px] text-slate-400">
                                <input
                                  type="checkbox"
                                  checked={field.isRequired}
                                  onChange={(e) =>
                                    updateField(field.key, { isRequired: e.target.checked })
                                  }
                                  className="h-3.5 w-3.5 rounded border-white/20 bg-white/5"
                                />
                                Required
                              </label>
                            </div>
                            {field.type === 'select' && (
                              <input
                                className="input py-1 text-[11px]"
                                value={field.options}
                                onChange={(e) => updateField(field.key, { options: e.target.value })}
                                placeholder="Options, comma separated"
                              />
                            )}
                            <input
                              className="input py-1 text-[11px]"
                              value={field.placeholder}
                              onChange={(e) =>
                                updateField(field.key, { placeholder: e.target.value })
                              }
                              placeholder="Placeholder (optional)"
                              maxLength={160}
                            />
                          </div>
                        ))}

                        <button
                          onClick={addField}
                          disabled={formFields.length >= 20}
                          className="btn-ghost w-full py-1 text-[11px] disabled:opacity-40"
                        >
                          + Add field
                        </button>

                        <div>
                          <label className="label text-[10px]" htmlFor="draft-cta-form-submit">
                            Submit button text
                          </label>
                          <input
                            id="draft-cta-form-submit"
                            className="input py-1.5 text-xs"
                            value={formSubmitText}
                            onChange={(e) => setFormSubmitText(e.target.value)}
                            maxLength={40}
                          />
                        </div>
                      </div>
                    )}
                  </div>

                  <button
                    onClick={formOnly ? saveForm : createOffer}
                    disabled={saving}
                    className="btn-primary w-full py-1.5 text-xs disabled:opacity-50"
                  >
                    {saving
                      ? 'Saving…'
                      : formOnly
                        ? 'Save form'
                        : editingId
                          ? 'Save changes'
                          : 'Create & show offer'}
                  </button>
                </div>
              )}

              {!loading && !composing && tab === 'quiz' && (
                <div className="space-y-2">
                  {quizzes.length === 0 && (
                    <p className="py-6 text-center text-xs text-slate-500">
                      No quizzes yet — tap “+ New” to write one now.
                    </p>
                  )}
                  {quizzes.map((q) => {
                    const isLive = activeQuiz?.id === q.id;
                    return (
                      <div
                        key={q.id}
                        className="rounded-xl border border-white/10 bg-white/[0.03] p-3"
                      >
                        <p className="text-xs font-medium text-slate-200">{q.question}</p>
                        <p className="mt-1 text-[11px] text-slate-500">
                          {q.options.length} options · {q.timeLimitSecs}s · {q.answerCount} answers
                        </p>
                        <div className="mt-2.5 flex gap-2">
                          {isLive ? (
                            <button
                              onClick={() => close(q.id)}
                              className="btn-ghost px-2.5 py-1 text-[11px]"
                            >
                              Close quiz
                            </button>
                          ) : (
                            <button
                              onClick={() => launch(q.id)}
                              className="btn-primary px-2.5 py-1 text-[11px]"
                            >
                              Launch
                            </button>
                          )}
                        </div>
                        <RowActions
                          id={q.id}
                          editLabel="Edit quiz"
                          busy={deleting}
                          confirming={confirmDelete === q.id}
                          onEdit={() => editQuiz(q)}
                          onAskDelete={() => setConfirmDelete(q.id)}
                          onCancelDelete={() => setConfirmDelete(null)}
                          onDelete={() => void removeRow('quiz', q.id)}
                        />
                      </div>
                    );
                  })}

                  {quizResults && (
                    <div className="mt-3 rounded-xl border border-brand-500/30 bg-brand-500/10 p-3">
                      <p className="text-[11px] font-semibold text-brand-200">Last results</p>
                      <p className="mt-1 text-[11px] text-slate-300">
                        {quizResults.correctCount}/{quizResults.totalAnswers} correct
                      </p>
                      <ul className="mt-2 space-y-1">
                        {Object.entries(quizResults.distribution).map(([optId, count]) => (
                          <li key={optId} className="flex items-center gap-2 text-[11px] text-slate-400">
                            <span className="w-4 font-mono text-slate-500">{optId}</span>
                            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
                              <span
                                className="block h-full rounded-full bg-brand-400"
                                style={{
                                  width: `${
                                    quizResults.totalAnswers
                                      ? (count / quizResults.totalAnswers) * 100
                                      : 0
                                  }%`,
                                }}
                              />
                            </span>
                            <span className="w-6 text-right tabular-nums">{count}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {!loading && !composing && tab === 'poll' && (
                <div className="space-y-2">
                  {polls.length === 0 && (
                    <p className="py-6 text-center text-xs text-slate-500">
                      No polls yet — tap “+ New” to write one now.
                    </p>
                  )}
                  {polls.map((p) => {
                    const isLive = activePoll?.id === p.id;
                    return (
                      <div
                        key={p.id}
                        className="rounded-xl border border-white/10 bg-white/[0.03] p-3"
                      >
                        <p className="text-xs font-medium text-slate-200">{p.question}</p>
                        <p className="mt-1 text-[11px] text-slate-500">
                          {p.options.length} options ·{' '}
                          {p.timeLimitSecs > 0 ? `${p.timeLimitSecs}s` : 'open until closed'} ·{' '}
                          {/* While the poll is live the stored count is stale —
                              votes are only persisted per-vote, not re-counted
                              into the list row. Prefer the live tally. */}
                          {isLive && pollResults ? pollResults.totalVotes : p.voteCount}{' '}
                          votes
                        </p>
                        <div className="mt-2.5 flex gap-2">
                          {isLive ? (
                            <button
                              onClick={() => closePoll(p.id)}
                              className="btn-ghost px-2.5 py-1 text-[11px]"
                            >
                              Close poll
                            </button>
                          ) : (
                            <button
                              onClick={() => launchPoll(p.id)}
                              className="btn-primary px-2.5 py-1 text-[11px]"
                            >
                              Launch
                            </button>
                          )}
                        </div>
                        <RowActions
                          id={p.id}
                          editLabel="Edit poll"
                          busy={deleting}
                          confirming={confirmDelete === p.id}
                          onEdit={() => editPoll(p)}
                          onAskDelete={() => setConfirmDelete(p.id)}
                          onCancelDelete={() => setConfirmDelete(null)}
                          onDelete={() => void removeRow('poll', p.id)}
                        />
                      </div>
                    );
                  })}

                  {pollResults && (
                    <div className="mt-3 rounded-xl border border-accent-500/30 bg-accent-500/10 p-3">
                      <p className="text-[11px] font-semibold text-accent-400">
                        {pollResults.closed ? 'Final tally' : 'Live tally'}
                      </p>
                      <p className="mt-1 text-[11px] text-slate-300">
                        {pollResults.totalVotes}{' '}
                        {pollResults.totalVotes === 1 ? 'vote' : 'votes'}
                      </p>
                      <ul className="mt-2 space-y-1">
                        {pollResults.options.map((opt) => {
                          const count = pollResults.distribution[opt.id] ?? 0;
                          return (
                            <li
                              key={opt.id}
                              className="flex items-center gap-2 text-[11px] text-slate-400"
                            >
                              <span className="w-4 font-mono text-slate-500">
                                {opt.id.toUpperCase()}
                              </span>
                              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
                                <span
                                  className="block h-full rounded-full bg-accent-500"
                                  style={{
                                    width: `${
                                      pollResults.totalVotes
                                        ? (count / pollResults.totalVotes) * 100
                                        : 0
                                    }%`,
                                  }}
                                />
                              </span>
                              <span className="w-6 text-right tabular-nums">{count}</span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {!loading && !composing && tab === 'offer' && followUpFor && (
                <CtaFollowUp ctaId={followUpFor} onClose={() => setFollowUpFor(null)} />
              )}

              {!loading && !composing && tab === 'offer' && !followUpFor && (
                <div className="space-y-2">
                  {ctas.length === 0 && (
                    <p className="py-6 text-center text-xs text-slate-500">
                      No offers yet — tap “+ New” to create one now.
                    </p>
                  )}
                  {ctas.map((c) => {
                    const isLive = activeCta?.id === c.id;
                    const price = c.priceOverridePaise ?? c.course?.pricePaise ?? 0;
                    return (
                      <div
                        key={c.id}
                        className="rounded-xl border border-white/10 bg-white/[0.03] p-3"
                      >
                        <p className="text-xs font-medium text-slate-200">{c.title}</p>
                        <p className="mt-1 text-[11px] text-slate-500">
                          {price ? `₹${(price / 100).toLocaleString('en-IN')}` : 'Free'}
                          {c.course ? ` · ${c.course.title}` : ''}
                        </p>
                        {/* The tally, live from the socket, falling back to the
                            count fetched with the list so it is right the
                            moment the panel opens. It is a summary only — the
                            names behind it live in the follow-up list. */}
                        <p className="mt-1 flex items-center gap-1.5 text-[11px] text-accent-400">
                          <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M9 11.5V6a1.5 1.5 0 0 1 3 0v5m0 0V4.5a1.5 1.5 0 0 1 3 0V11m0 0V6.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-1.2a5 5 0 0 1-3.9-1.9L4 14.5a1.6 1.6 0 0 1 2.4-2.1L9 15" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                          <span className="font-semibold tabular-nums">
                            {ctaClickCounts[c.id] ?? c.clickCount ?? 0}
                          </span>
                          opened
                          {c.formEnabled && (
                            <span className="text-slate-500">· form before payment</span>
                          )}
                        </p>
                        <div className="mt-2.5 flex flex-wrap gap-2">
                          {isLive ? (
                            <button
                              onClick={hideCta}
                              className="btn-ghost px-2.5 py-1 text-[11px]"
                            >
                              Hide offer
                            </button>
                          ) : (
                            <button
                              onClick={() => showCta(c.id)}
                              className="btn-primary px-2.5 py-1 text-[11px]"
                            >
                              Show to everyone
                            </button>
                          )}
                          <button
                            onClick={() => setFollowUpFor(c.id)}
                            className="btn-ghost px-2.5 py-1 text-[11px]"
                          >
                            Follow up
                          </button>
                          <button
                            onClick={() => editForm(c)}
                            className="btn-ghost px-2.5 py-1 text-[11px]"
                          >
                            {c.formEnabled ? 'Edit form' : 'Add form'}
                          </button>
                        </div>
                        <RowActions
                          id={c.id}
                          editLabel="Edit offer"
                          busy={deleting}
                          confirming={confirmDelete === c.id}
                          onEdit={() => editOffer(c)}
                          onAskDelete={() => setConfirmDelete(c.id)}
                          onCancelDelete={() => setConfirmDelete(null)}
                          onDelete={() => void removeRow('offer', c.id)}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* ── stage control ───────────────────────────── */}
            <div className="border-t border-white/10 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold text-white">Stage</p>
                  <p className="text-[10px] text-slate-500">
                    {spotlightedPeerId
                      ? 'One speaker is pinned to the big tile.'
                      : 'Pin a speaker to the big tile for everyone.'}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  {spotlightedPeerId && (
                    <button
                      onClick={() => spotlight(null)}
                      className="rounded-lg bg-white/10 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-white/15"
                    >
                      Clear spotlight
                    </button>
                  )}
                  <button
                    onClick={muteAll}
                    className="rounded-lg bg-white/10 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-white/15"
                  >
                    Mute all
                  </button>
                </div>
              </div>

              {speakers.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {speakers.map((p) => {
                    const active = p.peerId === spotlightedPeerId;
                    return (
                      <button
                        key={p.peerId}
                        onClick={() => spotlight(active ? null : p.peerId)}
                        className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold transition ${
                          active
                            ? 'border-brand-400/60 bg-brand-500/20 text-brand-200'
                            : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                        }`}
                      >
                        {active ? '★ ' : ''}
                        {p.name}
                      </button>
                    );
                  })}
                </div>
              )}

              {stageMsg && (
                <p className="mt-2 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[10px] text-slate-300">
                  {stageMsg}
                </p>
              )}
            </div>

            {/* ── go live ─────────────────────────────────── */}
            {canEndWebinar && startedAt === null && (
              <div className="border-t border-white/10 bg-brand-500/[0.06] px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold text-white">Start the webinar</p>
                    <p className="text-[10px] text-slate-500">
                      Participants are waiting. They join the moment you start.
                    </p>
                  </div>
                  <button
                    onClick={startWebinar}
                    disabled={starting}
                    className="shrink-0 rounded-lg bg-brand-500 px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-brand-400 disabled:opacity-50"
                  >
                    {starting ? 'Starting…' : 'Go live'}
                  </button>
                </div>
                {startError && (
                  <p className="mt-2 rounded-lg border border-red-500/30 bg-red-500/10 px-2 py-1 text-[10px] text-red-300">
                    {startError}
                  </p>
                )}
              </div>
            )}

            {/* ── recording ───────────────────────────────── */}
            {canEndWebinar && (
              <div className="border-t border-white/10 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold text-white">Session recording</p>
                    <p className="text-[10px] text-slate-500">
                      {recording
                        ? 'Capturing chat, quizzes and offers for replay.'
                        : 'Record this session so it can be replayed later.'}
                    </p>
                  </div>
                  <button
                    onClick={toggleRecording}
                    disabled={recBusy}
                    className={`shrink-0 rounded-lg px-2.5 py-1 text-[11px] font-semibold transition disabled:opacity-50 ${
                      recording
                        ? 'bg-amber-500 text-black hover:bg-amber-400'
                        : 'bg-white/10 text-white hover:bg-white/15'
                    }`}
                  >
                    {recBusy ? 'Working…' : recording ? 'Stop recording' : 'Start recording'}
                  </button>
                </div>
                {recError && (
                  <p className="mt-2 rounded-lg border border-red-500/30 bg-red-500/10 px-2 py-1 text-[10px] text-red-300">
                    {recError}
                  </p>
                )}
                {lastRecording && (
                  <a
                    href={`/replay/${lastRecording.id}`}
                    className="mt-2 inline-block text-[10px] font-semibold text-brand-300 hover:text-brand-200"
                  >
                    Watch the replay ({formatDuration(lastRecording.durationMs)}) →
                  </a>
                )}
              </div>
            )}

            {/* ── danger zone ─────────────────────────────── */}
            {canEndWebinar && (
              <div className="border-t border-white/10 bg-red-500/[0.04] px-4 py-3">
                {confirmEnd ? (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[11px] text-red-300">
                      End for everyone? This cannot be undone.
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setConfirmEnd(false)}
                        className="btn-ghost px-2.5 py-1 text-[11px]"
                        disabled={ending}
                      >
                        Cancel
                      </button>
                      <button
                        onClick={endWebinar}
                        disabled={ending}
                        className="rounded-lg bg-red-500 px-2.5 py-1 text-[11px] font-semibold text-white transition hover:bg-red-400 disabled:opacity-50"
                      >
                        {ending ? 'Ending…' : 'Yes, end it'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmEnd(true)}
                    className="text-[11px] font-semibold text-red-400 transition hover:text-red-300"
                  >
                    End webinar for everyone
                  </button>
                )}
              </div>
            )}
            </aside>
          </div>,
          document.body
        )}
    </>
  );
}

/**
 * Edit and delete for one authored row.
 *
 * The delete confirmation is inline rather than a `window.confirm` because the
 * panel is a portal over a live call — a native dialog steals focus from the
 * room and, on some browsers, suspends the audio context while it is open.
 */
function RowActions({
  id,
  editLabel,
  busy,
  confirming,
  onEdit,
  onAskDelete,
  onCancelDelete,
  onDelete,
}: {
  id: string;
  editLabel: string;
  busy: boolean;
  confirming: boolean;
  onEdit: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}) {
  if (confirming) {
    return (
      <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1.5">
        <p className="text-[11px] text-red-300">Delete this for good?</p>
        <button
          onClick={onCancelDelete}
          disabled={busy}
          className="btn-ghost px-2 py-0.5 text-[11px] disabled:opacity-40"
        >
          Cancel
        </button>
        <button
          onClick={onDelete}
          disabled={busy}
          className="rounded-lg bg-red-500 px-2 py-0.5 text-[11px] font-semibold text-white transition hover:bg-red-400 disabled:opacity-50"
        >
          {busy ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    );
  }

  return (
    <div className="mt-2.5 flex flex-wrap gap-2">
      <button onClick={onEdit} className="btn-ghost px-2.5 py-1 text-[11px]">
        {editLabel}
      </button>
      <button
        onClick={onAskDelete}
        aria-label={`Delete ${id}`}
        className="btn-ghost px-2.5 py-1 text-[11px] text-red-400 hover:text-red-300"
      >
        Delete
      </button>
    </div>
  );
}

/** `m:ss` — long enough for a webinar, short enough to sit in a link. */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}
