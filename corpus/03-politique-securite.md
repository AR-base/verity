# Politique de sécurité des systèmes d'information (PSSI)

*Version 2.0. Société fictive.*

## 1. Gestion des secrets

- Aucun mot de passe, clé d'API ou secret ne doit figurer dans le code source ni dans le dépôt Git.
- Les secrets sont fournis par des **variables d'environnement** ou par le coffre-fort de secrets de l'hébergeur.
- Tout secret exposé doit être révoqué et remplacé sous **24 heures**, et l'incident déclaré.

## 2. Mots de passe des utilisateurs

- Les mots de passe sont stockés uniquement sous forme de hachage **bcrypt** avec un facteur de coût d'**au moins 12**.
- Longueur minimale : 12 caractères.
- L'authentification multifacteur (MFA) est obligatoire pour les comptes administrateurs et pour l'accès à la messagerie depuis l'extérieur.
- Les collaborateurs utilisent le gestionnaire de mots de passe d'entreprise (Bitwarden) ; la réutilisation d'un mot de passe entre deux services est interdite.

## 3. Développement sécurisé

- Toutes les requêtes SQL utilisent des **requêtes paramétrées** ; la concaténation de données saisies par l'utilisateur dans une requête est interdite.
- Les entrées utilisateur sont validées côté serveur.
- Chaque modification de code est revue par un second développeur avant fusion.
- Les dépendances sont analysées chaque semaine ; une vulnérabilité critique doit être corrigée sous 7 jours.

## 4. Postes de travail

- Les disques des ordinateurs portables sont chiffrés (BitLocker ou FileVault).
- Le verrouillage automatique de session intervient après 5 minutes d'inactivité.
- Les clés USB personnelles sont interdites sur les postes de l'entreprise.
- L'accès aux serveurs depuis l'extérieur se fait uniquement par le VPN de l'entreprise.

## 5. Accès et revues

- Principe du moindre privilège pour tous les comptes.
- Revue des droits d'accès chaque trimestre par chaque responsable d'équipe.
- Les comptes d'un collaborateur qui quitte l'entreprise sont désactivés le jour de son départ.

## 6. Incidents

Tout incident de sécurité est déclaré dans Nexa Gestion comme ticket de catégorie « securite », priorité « critique », et signalé à securite@nexa-digital.example. Les e-mails suspects (hameçonnage) sont transférés à la même adresse sans cliquer sur les liens.
