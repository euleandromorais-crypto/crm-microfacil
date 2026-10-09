import { FormEvent, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Field } from '../components/ui';

export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(email, password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth-wrap">
      <form className="card auth-card stack" onSubmit={submit}>
        <div>
          <h1>CRM Comercial</h1>
          <p className="muted">Acesse com seu e-mail e senha.</p>
        </div>
        {error && <div className="alert error">{error}</div>}
        <Field label="E-mail">
          <input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </Field>
        <Field label="Senha">
          <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <button className="btn primary" disabled={busy}>{busy ? 'Entrando...' : 'Entrar'}</button>
        <Link to="/esqueci-senha" className="small">Esqueci minha senha</Link>
      </form>
    </div>
  );
}

export function ForgotPage() {
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.post('/api/auth/forgot', { email });
      setMsg(r.message);
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth-wrap">
      <form className="card auth-card stack" onSubmit={submit}>
        <h1>Recuperar senha</h1>
        {msg ? <div className="alert info">{msg}</div> : <p className="muted">Informe seu e-mail para receber o link de redefinição.</p>}
        <Field label="E-mail">
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <button className="btn primary" disabled={busy}>Enviar link</button>
        <Link to="/" className="small">Voltar ao login</Link>
      </form>
    </div>
  );
}

export function ResetPage() {
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError('As senhas não conferem');
    try {
      await api.post('/api/auth/reset', { token: sp.get('token'), password });
      setDone(true);
      setTimeout(() => nav('/'), 2000);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="auth-wrap">
      <form className="card auth-card stack" onSubmit={submit}>
        <h1>Nova senha</h1>
        {done ? <div className="alert success">Senha redefinida! Redirecionando para o login...</div> : null}
        {error && <div className="alert error">{error}</div>}
        <Field label="Nova senha" hint="Mínimo de 8 caracteres, com letras e números">
          <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
        </Field>
        <Field label="Confirme a senha">
          <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </Field>
        <button className="btn primary" disabled={done}>Salvar nova senha</button>
      </form>
    </div>
  );
}
