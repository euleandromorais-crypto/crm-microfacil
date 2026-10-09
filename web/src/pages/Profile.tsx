import { FormEvent, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Field, useToast } from '../components/ui';
import { ROLE_LABELS } from '../format';

export default function Profile() {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(user!.name);
  const [phone, setPhone] = useState(user!.phone ?? '');
  const [pw, setPw] = useState({ current: '', password: '', confirm: '' });
  const saveProfile = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.patch('/api/me', { name, phone: phone || null });
      await refresh();
      toast('Perfil atualizado');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const savePw = async (e: FormEvent) => {
    e.preventDefault();
    if (pw.password !== pw.confirm) return toast('As senhas não conferem', 'error');
    try {
      await api.post('/api/auth/password', { current: pw.current, password: pw.password });
      setPw({ current: '', password: '', confirm: '' });
      toast('Senha alterada. Outras sessões foram encerradas.');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  return (
    <div className="grid cols-2" style={{ maxWidth: 900 }}>
      <form className="card card-pad stack" onSubmit={saveProfile}>
        <h2>Meu perfil</h2>
        <div className="muted">{user!.email} · {ROLE_LABELS[user!.role]}</div>
        <Field label="Nome"><input className="input" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} /></Field>
        <Field label="Telefone"><input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
        <div><button className="btn primary">Salvar</button></div>
      </form>
      <form className="card card-pad stack" onSubmit={savePw}>
        <h2>Alterar senha</h2>
        <Field label="Senha atual"><input className="input" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required /></Field>
        <Field label="Nova senha" hint="Mínimo 8 caracteres, com letras e números"><input className="input" type="password" autoComplete="new-password" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} required minLength={8} /></Field>
        <Field label="Confirmar nova senha"><input className="input" type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} required /></Field>
        <div><button className="btn primary">Alterar senha</button></div>
      </form>
    </div>
  );
}
