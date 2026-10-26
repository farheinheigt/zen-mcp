# Organisation native de Zen

## Contrat

Les commandes MCP doivent lire et modifier les espaces, dossiers, onglets épinglés et vues Split par les fonctions du navigateur en cours d'exécution, sans édition hors ligne de ses sessions.

- Spaces : lister, créer, modifier nom/icône, sélectionner, réordonner, fusionner et supprimer seulement si vide.
- Onglets natifs : lister avec identifiants stables, créer, déplacer entre espaces/dossiers, épingler/désépingler. Les essentiels sont distingués des épinglés ordinaires et ne sont pas convertis implicitement.
- Dossiers : lister avec parents, créer, renommer, déplacer, supprimer seulement si vide ou dégrouper en conservant les pages.
- Splits : lister, créer avec 2 à 4 onglets du même espace et état épinglé, choisir la disposition, séparer en conservant toutes les pages. Les déplacements d'un membre doivent préserver le Split entier ou être refusés.
- Une fusion d'espaces conserve pages, dossiers, relations de parenté, Splits et état épinglé. Elle conserve l'identité et l'icône de la destination. Un nom déjà utilisé est refusé à la création ou au renommage.
- Les identifiants inexistants, cycles de dossiers, listes d'ordre incomplètes, mélanges incompatibles et suppressions non vides produisent une erreur avant mutation.

## Frontière d'accès

Le pilote natif Marionette est optionnel, local uniquement, et exige un chemin de profil autorisé explicite. Le serveur vérifie le profil réel avant toute commande native. Aucune commande MCP n'expose d'évaluation JavaScript privilégiée arbitraire. Tous les appels MCP sont sérialisés. BiDi et Marionette utilisent successivement une session WebDriver, jamais simultanément. Une fusion ou suppression d’espace est refusée si plusieurs fenêtres sont présentes dans le profil autorisé ; les autres opérations natives ciblent sa fenêtre la plus récente. En cas de délai dépassé, l'opération n'est pas rejouée automatiquement.

## Preuves

Tests unitaires du transport et des refus ; tests d'intégration MCP sur un profil Zen neuf dédié, avec données synthétiques. Ce profil ne copie ni cookies, ni authentification, ni données du profil personnel. Vérification des données après mutations et redémarrage. Le profil de test et les journaux sont ignorés par Git.
