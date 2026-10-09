# Segurança e LGPD

## Segurança implementada

- **Senhas** com bcrypt (custo 12); política mínima (8+ caracteres, letras e números); bloqueio de 15 min após 5 tentativas;
  limite de requisições no login e na recuperação de senha; resposta idêntica para e-mails inexistentes.
- **Sessões** em cookie `HttpOnly`, `Secure`, `SameSite=Lax`; token armazenado apenas como hash; expiração configurável; sessões
  encerradas ao desativar usuário, trocar perfil ou senha.
- **CSRF**: requisições que alteram dados exigem cabeçalho customizado (`X-Requested-With`), que navegadores não enviam entre sites.
- **Permissões** verificadas no servidor em todas as rotas e consultas.
- **Credenciais de integração** (tokens da Meta, segredos) criptografadas com AES-256-GCM (`APP_ENCRYPTION_KEY`); exibidas mascaradas.
- **Chaves de API** armazenadas como hash, exibidas uma única vez, com restrição de origem e honeypot anti-spam.
- **Webhooks** com validação de assinatura HMAC (Meta e webhooks de entrada) e assinatura nos webhooks de saída (com timestamp).
- **Cabeçalhos de segurança** (Helmet/CSP), HTTPS obrigatório via Nginx + HSTS, firewall (UFW).
- **Auditoria** de logins, alterações de cadastro, exportações, mesclagens, mudanças de permissão e de integrações.
- **SQL** sempre parametrizado; validação de entrada com Zod.

## LGPD

| Princípio | Como o sistema atende |
|---|---|
| Finalidade / consentimento | Campo de consentimento para WhatsApp com data; automações só enviam modelos a quem consentiu |
| Minimização | Webhooks de saída enviam apenas dados essenciais; exportações restritas a gestores e auditadas |
| Acesso restrito | Vendedores veem somente sua carteira |
| Direitos do titular | Exportação de dados do lead; **anonimização** (Administração no perfil do lead) remove nome, contatos, documentos, notas e conteúdo de mensagens, preservando apenas números agregados |
| Segurança | Itens acima; backups criptografáveis em destino externo |
| Retenção | Limpeza automática de eventos técnicos (webhooks processados 90 dias, logs 180 dias, notificações lidas 90 dias) |

Recomendações operacionais: incluir no formulário da landing page o aviso de privacidade e a caixa de consentimento
(o exemplo da tela de Integrações já traz), definir o encarregado (DPO) e registrar a base legal no aviso de privacidade.
