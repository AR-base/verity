# Guide d'accueil des développeurs

*Société fictive.*

## 1. Première semaine

Le premier jour, le nouvel arrivant reçoit son ordinateur portable chiffré, ses accès (messagerie, Git, Nexa Gestion, VPN) et un parrain dans son équipe. La première semaine est consacrée à l'installation de l'environnement, à la lecture de la PSSI et à une première correction de bug accompagnée.

## 2. Le dépôt Nexa Gestion

- `src/routes/` : routes de l'API (clients, factures, tickets).
- `src/billing/` : facturation et relances automatiques.
- `src/support/` : calcul des délais de support (SLA).
- `src/jobs/` : tâches planifiées (relances quotidiennes, purges RGPD).
- `tests/` : tests automatisés, exécutés à chaque pull request.

## 3. Règles de travail

1. Une branche par fonctionnalité, nommée `feature/…` ou `fix/…`.
2. Pull request obligatoire, avec au moins une revue.
3. Les tests doivent passer avant toute fusion ; la couverture minimale est de 70 %.
4. Aucun secret dans le code : utiliser le fichier `.env` (jamais versionné).

## 4. Mise en production

Les mises en production ont lieu du lundi au jeudi, jamais le vendredi ni la veille d'un jour férié. Chaque mise en production est annoncée sur le canal #deploiements et peut être annulée par un retour arrière automatique en moins de 10 minutes.

## 5. Conventions

- JavaScript moderne (Node.js 20), modules CommonJS.
- Requêtes SQL paramétrées uniquement.
- Les constantes métier (délais, taux) doivent correspondre aux procédures validées par la direction.
