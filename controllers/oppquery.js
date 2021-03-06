var _ = require('lodash');
var OppQueryForm = require('../lib/OppQueryForm.js');
var SendRequestForm = require('../lib/SendRequestForm.js');
var searchResults = require('../test/mocks/searchResults');
var Searcher = require('../lib/SearchQuery');
var MailBoss = require('../lib/MailBoss');
var mailBoss = new MailBoss();
var KeenBoss = require('../lib/KeenBoss');
var keenBoss = new KeenBoss();
var db = require('../models');
var sequelize = db.sequelize;

module.exports = function(app) {
  app.get('/preguntas', oppQueryCreate);
  app.get('/results', oppQueryExecute);
  app.get('/results/picked/confirm', oppQueryConfirmPickedResults);
  app.post('/results/pick', oppQueryPickResults);
  app.post('/sendlead', oppQuerySendLead);
  app.get('/debug/keen', oppQuerySendLeadKeenDebug);
  app.get('/debug/email-template/:emailTemplate/:emailOp', oppQuerySendLeadDebug);
};

/**
 * GET /preguntas
 * Build and render FundMe Wizard.
 */
var oppQueryCreate = function(req, res, next) {
  var options = options || {};
  var oppQueryForm = new OppQueryForm();
  res.render('fundmeWizard', {
    title: 'Preguntas',
    bodyClass: 'fundmeWizard',
    form: oppQueryForm.getFormConfig(true), // Deep.
    formInfo: oppQueryForm.getFormConfig(false) // Shallow.
  });
};

/**
 * Get /results
 * Get the query request, execute, and redner the results page
 */
var oppQueryExecute = function(req, res, next) {
  var query = req.query;
  var builtQuery = sequelize.model('submission').buildFromAdminForm(req.query).modelData;
  var searcher = new Searcher(builtQuery);
  searcher.execute().success(function() {
    var original_result = _.clone(searcher.result);
    var benefitTypes = Searcher.extractBenefitTypes(searcher.result);
    var searchResult = Searcher.structureResultByBenefitType(benefitTypes, searcher.formatResult());
   // DEBUG
   /* return res.json({
      builtQuery: builtQuery,
      originalResult: original_result,
      newResult: searchResult,
      benefitTypes: benefitTypes
    });*/
    req.session.query = builtQuery;
    return res.render('searchResults', {
      title: 'Ver Resultados',
      bodyClass: 'searchResults',
      displayCart: true,
      searchResult: searchResult,
      benefitTypes: benefitTypes,
      accordionPanelRenderList: accordionPanelRenderList,
      meta: { type: 'searchResults' }
    });
  });
};

/**
 * POST /results/pick
 * Receives the results from Cart's XHR request. Stores them in session.
 */
var oppQueryPickResults = function(req, res, next) {
  // TODO -- security hoooolllleeee?
  // Recycle Searcher to format the incoming result from collection.
  // Don't re-format.
  var pickedBenefitTypes = Searcher.extractBenefitTypes(req.body);
  req.session.cart = { programs: req.body };
  return res.json(200, { status: 'ok' });
}
/**
 * GET /results/picked/confirm
 * This is the page that successful cart save redirects to.
 * Checks for cart data, and if they exist, builds the confirm page.
 */

var oppQueryConfirmPickedResults = function(req, res, next) {
  if (_.isEmpty(req.session.cart) || _.isEmpty(req.session.query) || _.isEmpty(req.session.cart.programs))
    return res.redirect('/preguntas');

  var pickedBenefitTypes = Searcher.extractBenefitTypes(req.session.cart.programs);
  var cartContents = req.session.cart.programs;

  var sendRequestForm = new SendRequestForm();
  return res.render('confirmPicked', {
    title: 'Has seleccionado',
    bodyClass: 'confirmPickedResults',
    pickedResults: cartContents,
    benefitTypes: pickedBenefitTypes,
    accordionPanelRenderList: accordionPanelRenderList,
    form: sendRequestForm.getFormConfig(true), // Deep.
    formInfo: sendRequestForm.getFormConfig(false), // Shallow.
    meta: { type: 'confirmPicked' }
  });
};

/**
 * POST /sendLead
 * Handler for sending lead.  Returns confirm page
 */
var oppQuerySendLead = function(req, res, next) {
  var createdSubmission;
  var Submission = sequelize.model('submission');
  var leadData = {
    selectedPrograms: req.session.cart.programs || {},
    query: req.session.query || {},
    submitter: req.body
  };
  leadData.subSaveData = _.extend(leadData.query, _.omit(leadData.submitter, ['_csrf']));
  // Create submission.
  Submission.create(leadData.subSaveData).then(function(createdSub) {
    createdSubmission = createdSub;
    return createdSub.setOpportunities(_.map(leadData.selectedPrograms, function(program) {
      return program.id;
    }));
  }).then(function() {
    var dispatchMailOptionsSet = [];
    // Let's dispatch some emails.
    var agencyEmails = _.keys(_.groupBy(leadData.selectedPrograms, function(program) {
      return program.agencyContactEmail;
    }));
    // First send to default receivers and all the heads;
    var locals = _.extend(res.locals, {
      emailTitle: 'Formulario de solicitud de PrimerPeso',
      leadData: leadData.subSaveData,
      selectedPrograms: leadData.selectedPrograms
    });
    dispatchMailOptionsSet.push({
      subject: "Formulario de solicitud de PrimerPeso",
      template: "sendlead-agency",
      locals: locals,
      to: agencyEmails,
      sendToDefaults: true
    });
    dispatchMailOptionsSet.push({
      subject: "Gracias de PrimerPeso",
      template: "sendlead-customer",
      locals: locals,
      to: new Array(leadData.subSaveData.email)
    });
    mailBoss.dispatch(dispatchMailOptionsSet).then(function(dispatchResult) {
      // Finally, dispatch to keen and render.
      //return res.json({ssd: subSaveData, sp: leadData.selectedPrograms});
      keenBoss.addEvent('submissions', _.omit(leadData, ['submitter', 'query']))
      .then(function(movedEvent) {
        return res.render('leadSentConfirmation', {
          title: 'Solicitud Enviada',
          bodyClass: 'leadSentConfirmation',
          meta: { type: 'leadSentConfirmation' },
          leadData: leadData.subSaveData,
          selectedPrograms: leadData.selectedPrograms
        });
      });
    });
  });
}

// Template = name of template from email_templates_folder;
// emailOp = name of email operation = send or render;
var oppQuerySendLeadDebug = function(req, res, next) {
  var Submission = sequelize.model('submission');
  var emailTemplate = req.params.emailTemplate;
  var emailOp = req.params.emailOp;
  var leadData = require('../test/mocks/emailData')(emailTemplate);
  var dispatchMailOptionsSet = [];
  var agencyEmails = _.keys(_.groupBy(leadData.selectedPrograms, function(program) {
    return program.agencyContactEmail;
  }));
  // First send to default receivers and all the heads;
  var locals = _.extend(res.locals, {
    emailTitle: 'Formulario de solicitud de PrimerPeso',
    leadData: leadData.subSaveData,
    selectedPrograms: leadData.selectedPrograms
  });
  dispatchMailOptionsSet.push({
    subject: "Test Subject",
    template: emailTemplate,
    locals: locals,
    sendToDefaults: true
  });
  dispatchMailOptionsSet.push({
    subject: "Test Subject 2",
    template: emailTemplate,
    locals: locals
  });

  if (req.params.emailOp === 'send') {
    mailBoss.dispatch(dispatchMailOptionsSet).then(function(data) {
      return res.json(data);
    });
  }
  else {
    var renderOnly = true;
    mailBoss.dispatch(_.first(dispatchMailOptionsSet), renderOnly).then(function(html) {
      return res.send(_.first(html));
    });
  }
}

var oppQuerySendLeadKeenDebug = function(req, res, next) {
  var Submission = sequelize.model('submission');
  var leadData = require('../test/mocks/emailData')('sendlead-agency');
  keenBoss.addEvent('submissions', _.omit(leadData, ['submitter', 'query'])).then(function(movedEvent) {
    return res.json(movedEvent);
  });
}

var accordionPanelRenderList = {
  opportunity: {
    benefitDescription: 'Descripción',
    paperworkRequired: 'Documentación requerida',
    applicationCost: 'Costo de Solicitud',
    additionalGeneralInformation: 'Informacion Adicional'
  },
  agency: {
    name: 'Nombre De Agencia',
    web: 'Sitio Web de Agencia',
    phone: 'Numero de Telefono de Agencia',
  },
  requirements: {
    link: 'Sitio Web Para Obtener Requisito',
    cost: 'Costo del Requisito'
  }
};

