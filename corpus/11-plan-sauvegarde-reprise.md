# Plan de sauvegarde et de reprise d'activité (PRA)

*Société fictive.*

## 1. Objectifs de reprise

| Service | RPO (perte de données maximale) | RTO (durée maximale d'interruption) |
|---|---|---|
| Sites et applications des clients en maintenance | 24 heures | 4 heures |
| Nexa Gestion (outil interne) | 1 heure | 8 heures |
| Messagerie | 24 heures | 24 heures |

## 2. Règle 3-2-1

Les données sont conservées en trois copies, sur deux supports différents, dont une copie hors site. Les sauvegardes de production sont réalisées chaque nuit à 2 h chez OVHcloud (Roubaix) et répliquées chez Scaleway (Paris). Elles sont chiffrées et conservées 35 jours.

## 3. Tests de restauration

Une restauration complète d'un site client choisi au hasard est testée **chaque trimestre**. Le résultat (durée, problèmes rencontrés) est consigné dans le registre des tests de restauration. Une sauvegarde qui n'a jamais été restaurée n'est pas considérée comme fiable.

## 4. Déclenchement du PRA

Le PRA est déclenché par le directeur technique ou, en son absence, par l'ingénieur d'astreinte, lorsque l'hébergement principal est indisponible depuis plus d'une heure sans perspective de retour rapide.
